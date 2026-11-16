// AuraAPO.dll — an Audio Processing Object that Windows loads into the audio engine
// (audiodg.exe) and runs on every buffer captured from the microphone it is attached to.
// Every program that records from that microphone receives the processed voice.

#include "aura_shared.h"
#include "aura_denoise.h"
#include "aura_dereverb.h"
#ifdef AURA_HAVE_DFN
#include "aura_dfn.h"
#endif

#include <mmreg.h>
#include <ks.h>
#include <ksmedia.h>
#include <audioenginebaseapo.h>
#include <xmmintrin.h>

#include <atomic>
#include <cstdio>
#include <new>
#include <vector>

namespace {

std::atomic<long> gObjects{0};

// ───── Live settings: written by the watcher thread, read by the real-time thread ─────

constexpr int kValues = 15;

struct Live {
  std::atomic<bool> enabled{true};
  std::atomic<bool> mute{false};
  std::atomic<int> nsEngine{0};
  // DeepFilterNet: 0 = not available, 1 = available, -1 = switched off because loading it crashed last time.
  std::atomic<int> deepState{0};
  std::atomic<int> deepActive{0};
  std::atomic<unsigned> deepFrames{0};
  std::atomic<float> v[kValues];
  std::atomic<int> sampleRate{0}, channels{0};
  std::atomic<unsigned> blocks{0};
  // Meters for the window: the audio thread raises them, the watcher reads and resets.
  std::atomic<float> peakIn{0}, peakOut{0}, reduction{0}, voice{0};
  std::atomic<float> loudness{-70}; // short-term LUFS of what leaves the microphone
} gLive;

inline void raise(std::atomic<float>& meter, float value) {
  if (value > meter.load(std::memory_order_relaxed)) meter.store(value, std::memory_order_relaxed);
}

void store(const aura::Settings& s) {
  const aura::Params& p = s.params;
  const float values[kValues] = {p.warmth, p.clarity, p.air, p.density, p.width, p.space, p.clean,
                                 p.deess, p.autoLevel, p.inGainDb, p.outGainDb, p.pop, s.nsStrength,
                                 p.pitch, s.dereverb};
  for (int i = 0; i < kValues; i++) gLive.v[i].store(values[i], std::memory_order_relaxed);
  gLive.enabled.store(s.enabled, std::memory_order_relaxed);
  gLive.mute.store(s.mute, std::memory_order_relaxed);
  gLive.nsEngine.store(s.nsEngine, std::memory_order_relaxed);
}

aura::Settings load() {
  aura::Settings s;
  aura::Params& p = s.params;
  float* fields[kValues] = {&p.warmth, &p.clarity, &p.air, &p.density, &p.width, &p.space, &p.clean,
                            &p.deess, &p.autoLevel, &p.inGainDb, &p.outGainDb, &p.pop, &s.nsStrength,
                            &p.pitch, &s.dereverb};
  for (int i = 0; i < kValues; i++) *fields[i] = gLive.v[i].load(std::memory_order_relaxed);
  s.enabled = gLive.enabled.load(std::memory_order_relaxed);
  s.mute = gLive.mute.load(std::memory_order_relaxed);
  s.nsEngine = gLive.nsEngine.load(std::memory_order_relaxed);
  return s;
}

bool readSettings(const std::wstring& path) {
  const HANDLE f = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                               nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (f == INVALID_HANDLE_VALUE) return false;
  char text[4096];
  DWORD got = 0;
  const BOOL ok = ReadFile(f, text, sizeof(text) - 1, &got, nullptr);
  CloseHandle(f);
  if (!ok) return false;
  text[got] = 0;
  store(aura::parseSettings(text, load()));
  return true;
}

void writeStatus(const std::wstring& path) {
  auto db = [](float peak) { return 20.0 * std::log10(double(peak) + 1e-6); };
  char text[256];
  const int len = std::snprintf(
      text, sizeof(text), "alive=1\r\nsr=%d\r\nch=%d\r\nblocks=%u\r\nenabled=%d\r\nmute=%d\r\nin=%.1f\r\nout=%.1f\r\ngr=%.1f\r\nvoice=%.2f\r\nlufs=%.1f\r\ndeep=%d\r\nengine=%d\r\n",
      gLive.sampleRate.load(), gLive.channels.load(), gLive.blocks.load(), gLive.enabled.load() ? 1 : 0,
      gLive.mute.load() ? 1 : 0, db(gLive.peakIn.exchange(0)), db(gLive.peakOut.exchange(0)),
      -double(gLive.reduction.exchange(0)), double(gLive.voice.exchange(0)), double(gLive.loudness.load()), gLive.deepState.load(),
      gLive.deepActive.load());
  const HANDLE f = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS,
                               FILE_ATTRIBUTE_NORMAL, nullptr);
  if (f == INVALID_HANDLE_VALUE) return;
  DWORD put = 0;
  WriteFile(f, text, DWORD(len), &put, nullptr);
  CloseHandle(f);
}

// One watcher for all instances: polls settings.txt and leaves a heartbeat in status.txt.
SRWLOCK gWatchLock = SRWLOCK_INIT;
long gWatchUsers = 0;
HANDLE gWatchThread = nullptr;
HANDLE gWatchStop = nullptr;

// ───── DeepFilterNet loading ─────
// The model takes ~250 ms to load, so it is loaded here — by LockForProcess or by the watcher
// thread — and handed to the audio thread through an atomic pointer.
//
// The library aborts the whole process if it cannot digest its model. To make sure that can
// never take the audio engine down twice, a marker file is left before the first load and
// removed once real audio has gone through; finding a stale marker means "it crashed last
// time", and the deep engine then stays off until the user picks it again in the window.
HINSTANCE gModule = nullptr;
class AuraApo;
SRWLOCK gInstancesLock = SRWLOCK_INIT;
std::vector<AuraApo*> gInstances;
void loadDeepEverywhere(); // defined after the class

#ifdef AURA_HAVE_DFN
SRWLOCK gDeepLock = SRWLOCK_INIT;
bool gMarkerOurs = false, gDeepProven = false; // guarded by gDeepLock

std::wstring deepModelPath() {
  wchar_t buf[MAX_PATH];
  GetModuleFileNameW(gModule, buf, MAX_PATH);
  const std::wstring path(buf);
  return path.substr(0, path.find_last_of(L'\\')) + L"\\DeepFilterNet3_onnx.tar.gz";
}
std::wstring deepMarkerPath() { return aura::dataDir() + L"\\deep.loading"; }
bool exists(const std::wstring& path) { return GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES; }

// Refreshes gLive.deepState; with `claim`, also leaves the marker so a load may start.
bool deepAllowed(bool claim) {
  AcquireSRWLockExclusive(&gDeepLock);
  int state = 1;
  if (!exists(deepModelPath())) state = 0;
  else if (!gDeepProven && !gMarkerOurs) {
    if (exists(deepMarkerPath())) state = -1;
    else if (claim) {
      const HANDLE f = CreateFileW(deepMarkerPath().c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
      if (f != INVALID_HANDLE_VALUE) CloseHandle(f);
      gMarkerOurs = true;
    }
  }
  gLive.deepState.store(state);
  ReleaseSRWLockExclusive(&gDeepLock);
  return state == 1;
}

void deepHousekeeping() {
  AcquireSRWLockExclusive(&gDeepLock);
  if (gMarkerOurs && gLive.deepFrames.load() > 300) { // three seconds of real audio went through: it works
    DeleteFileW(deepMarkerPath().c_str());
    gMarkerOurs = false;
    gDeepProven = true;
  }
  ReleaseSRWLockExclusive(&gDeepLock);
}
#endif

DWORD WINAPI watch(void*) {
  const std::wstring settings = aura::dataDir() + L"\\settings.txt";
  const std::wstring status = aura::dataDir() + L"\\status.txt";
  FILETIME seen = {};
  for (int tick = 0;; tick++) {
    WIN32_FILE_ATTRIBUTE_DATA info;
    if (GetFileAttributesExW(settings.c_str(), GetFileExInfoStandard, &info) &&
        CompareFileTime(&info.ftLastWriteTime, &seen) != 0 && readSettings(settings)) {
      seen = info.ftLastWriteTime;
    }
#ifdef AURA_HAVE_DFN
    if (tick % 8 == 0) {
      deepAllowed(false);
      deepHousekeeping();
      if (gLive.nsEngine.load() == 1) loadDeepEverywhere(); // the user switched engines while a stream is open
    }
#endif
    writeStatus(status); // every 120 ms: it doubles as the level meter feed
    if (WaitForSingleObject(gWatchStop, 120) == WAIT_OBJECT_0) break;
  }
  DeleteFileW(status.c_str());
  return 0;
}

void watchAcquire() {
  AcquireSRWLockExclusive(&gWatchLock);
  if (gWatchUsers++ == 0) {
    store(aura::Settings());
    readSettings(aura::dataDir() + L"\\settings.txt"); // have the right sound from the very first buffer
    gWatchStop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    gWatchThread = gWatchStop ? CreateThread(nullptr, 0, watch, nullptr, 0, nullptr) : nullptr;
  }
  ReleaseSRWLockExclusive(&gWatchLock);
}

void watchRelease() {
  AcquireSRWLockExclusive(&gWatchLock);
  if (--gWatchUsers == 0) {
    if (gWatchStop) SetEvent(gWatchStop);
    if (gWatchThread) {
      WaitForSingleObject(gWatchThread, 3000);
      CloseHandle(gWatchThread);
    }
    if (gWatchStop) CloseHandle(gWatchStop);
    gWatchThread = gWatchStop = nullptr;
  }
  ReleaseSRWLockExclusive(&gWatchLock);
}

// ───── The APO ─────

bool isFloat32(const UNCOMPRESSEDAUDIOFORMAT& f) {
  return IsEqualGUID(f.guidFormatType, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) && f.dwBytesPerSampleContainer == 4 &&
         f.dwValidBitsPerSample == 32 && f.dwSamplesPerFrame >= 1 && f.dwSamplesPerFrame <= 8;
}

// The audio engine creates effects *aggregated*: as an inner part of its own COM object.
// The inner object then needs a private IUnknown, while every public interface forwards
// QueryInterface/AddRef/Release to the outer object.
struct INonDelegatingUnknown {
  virtual HRESULT STDMETHODCALLTYPE NonDelegatingQueryInterface(REFIID iid, void** out) = 0;
  virtual ULONG STDMETHODCALLTYPE NonDelegatingAddRef() = 0;
  virtual ULONG STDMETHODCALLTYPE NonDelegatingRelease() = 0;
};

class AuraApo final : public INonDelegatingUnknown,
                      public IAudioProcessingObject,
                      public IAudioProcessingObjectRT,
                      public IAudioProcessingObjectConfiguration,
                      public IAudioSystemEffects {
 public:
  explicit AuraApo(IUnknown* outer)
      : outer_(outer ? outer : reinterpret_cast<IUnknown*>(static_cast<INonDelegatingUnknown*>(this))) {
    gObjects++;
  }
  ~AuraApo() {
    if (locked_) leave();
    gObjects--;
  }

  // Loader side only (LockForProcess or the watcher thread) — never the audio thread.
  void loadDeep() {
#ifdef AURA_HAVE_DFN
    if (deep_.ready() || sampleRate_ != 48000.0f || !deepAllowed(true)) return;
    char utf8[MAX_PATH * 3];
    if (WideCharToMultiByte(CP_UTF8, 0, deepModelPath().c_str(), -1, utf8, sizeof(utf8), nullptr, nullptr) > 0) deep_.load(utf8, sampleRate_);
#endif
  }

  // Private IUnknown: the real reference count and interface table.
  STDMETHODIMP NonDelegatingQueryInterface(REFIID iid, void** out) override {
    if (!out) return E_POINTER;
    if (iid == __uuidof(IUnknown)) {
      *out = static_cast<INonDelegatingUnknown*>(this);
      NonDelegatingAddRef();
      return S_OK;
    }
    if (iid == __uuidof(IAudioProcessingObject)) *out = static_cast<IAudioProcessingObject*>(this);
    else if (iid == __uuidof(IAudioProcessingObjectRT)) *out = static_cast<IAudioProcessingObjectRT*>(this);
    else if (iid == __uuidof(IAudioProcessingObjectConfiguration)) *out = static_cast<IAudioProcessingObjectConfiguration*>(this);
    else if (iid == __uuidof(IAudioSystemEffects)) *out = static_cast<IAudioSystemEffects*>(this);
    else { *out = nullptr; return E_NOINTERFACE; }
    outer_->AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) NonDelegatingAddRef() override { return ULONG(++ref_); }
  STDMETHODIMP_(ULONG) NonDelegatingRelease() override {
    const long left = --ref_;
    if (left == 0) delete this;
    return ULONG(left);
  }

  // Public IUnknown: forwarded to the outer object (or to ourselves when not aggregated).
  STDMETHODIMP QueryInterface(REFIID iid, void** out) override { return outer_->QueryInterface(iid, out); }
  STDMETHODIMP_(ULONG) AddRef() override { return outer_->AddRef(); }
  STDMETHODIMP_(ULONG) Release() override { return outer_->Release(); }

  // IAudioProcessingObject
  STDMETHODIMP Reset() override { return S_OK; }
  STDMETHODIMP GetLatency(HNSTIME* time) override {
    if (!time) return E_POINTER;
    *time = 0;
    return S_OK;
  }
  STDMETHODIMP GetRegistrationProperties(APO_REG_PROPERTIES** out) override {
    if (!out) return E_POINTER;
    auto* p = static_cast<APO_REG_PROPERTIES*>(CoTaskMemAlloc(sizeof(APO_REG_PROPERTIES)));
    if (!p) return E_OUTOFMEMORY;
    ZeroMemory(p, sizeof(*p));
    p->clsid = aura::kClsid;
    p->Flags = APO_FLAG(APO_FLAG_DEFAULT | APO_FLAG_INPLACE);
    lstrcpynW(p->szFriendlyName, aura::kFriendlyName, 256);
    lstrcpynW(p->szCopyrightInfo, aura::kCopyright, 256);
    p->u32MajorVersion = 1;
    p->u32MinInputConnections = p->u32MaxInputConnections = 1;
    p->u32MinOutputConnections = p->u32MaxOutputConnections = 1;
    p->u32MaxInstances = 0xffffffff;
    p->u32NumAPOInterfaces = 1;
    p->iidAPOInterfaceList[0] = __uuidof(IAudioProcessingObject);
    *out = p;
    return S_OK;
  }
  STDMETHODIMP Initialize(UINT32, BYTE*) override { return S_OK; }
  STDMETHODIMP IsInputFormatSupported(IAudioMediaType* opposite, IAudioMediaType* requested, IAudioMediaType** supported) override {
    return formatSupported(opposite, requested, supported);
  }
  STDMETHODIMP IsOutputFormatSupported(IAudioMediaType* opposite, IAudioMediaType* requested, IAudioMediaType** supported) override {
    return formatSupported(opposite, requested, supported);
  }
  STDMETHODIMP GetInputChannelCount(UINT32* count) override {
    if (!count) return E_POINTER;
    *count = channels_;
    return S_OK;
  }

  // IAudioProcessingObjectConfiguration
  STDMETHODIMP LockForProcess(UINT32 numIn, APO_CONNECTION_DESCRIPTOR** in, UINT32 numOut, APO_CONNECTION_DESCRIPTOR** out) override {
    if (numIn != 1 || numOut != 1 || !in || !out || !in[0] || !out[0] || !in[0]->pFormat) return E_INVALIDARG;
    if (locked_) return APOERR_APO_LOCKED;
    UNCOMPRESSEDAUDIOFORMAT f;
    const HRESULT hr = in[0]->pFormat->GetUncompressedAudioFormat(&f);
    if (FAILED(hr)) return hr;
    if (!isFloat32(f) || f.fFramesPerSecond < 8000) return APOERR_FORMAT_NOT_SUPPORTED;

    channels_ = f.dwSamplesPerFrame;
    capacity_ = in[0]->u32MaxFrameCount > 0 ? in[0]->u32MaxFrameCount : 4096;
    try {
      mono_.assign(capacity_, 0.0f);
      left_.assign(capacity_, 0.0f);
      right_.assign(capacity_, 0.0f);
      chain_ = aura::Chain();
      chain_.prepare(f.fFramesPerSecond);
      denoise_.prepare(f.fFramesPerSecond); // stays off at other sample rates
      dereverb_.prepare(f.fFramesPerSecond);
      // Loudness meter (ITU-R BS.1770 K-weighting: a high shelf for the head, a high-pass for rumble).
      for (int c = 0; c < 2; c++) {
        kShelf_[c] = aura::Biquad();
        kShelf_[c].highshelf(f.fFramesPerSecond, 1682.0f, 4.0f);
        kHigh_[c] = aura::Biquad();
        kHigh_[c].highpass(f.fFramesPerSecond, 38.0f, 0.5f);
        meanSquare_[c] = 0;
      }
      loudnessCoef_ = aura::onePole(1.5f, f.fFramesPerSecond);
    } catch (const std::bad_alloc&) {
      return E_OUTOFMEMORY;
    }
    gLive.sampleRate = int(f.fFramesPerSecond);
    gLive.channels = int(channels_);
    sampleRate_ = f.fFramesPerSecond;
    watchAcquire();
    AcquireSRWLockExclusive(&gInstancesLock);
    gInstances.push_back(this);
    ReleaseSRWLockExclusive(&gInstancesLock);
    if (gLive.nsEngine.load() == 1) loadDeep(); // have it ready for the very first buffer
    mix_ = gLive.enabled.load() ? 1.0f : 0.0f;
    locked_ = true;
    return S_OK;
  }
  STDMETHODIMP UnlockForProcess() override {
    if (!locked_) return APOERR_ALREADY_UNLOCKED;
    locked_ = false;
    leave();
    return S_OK;
  }

  // IAudioProcessingObjectRT — real-time thread: no locks, no allocation, no I/O.
  STDMETHODIMP_(void) APOProcess(UINT32, APO_CONNECTION_PROPERTY** in, UINT32, APO_CONNECTION_PROPERTY** out) override {
    const UINT32 frames = in[0]->u32ValidFrameCount;
    const float* src = reinterpret_cast<const float*>(in[0]->pBuffer);
    float* dst = reinterpret_cast<float*>(out[0]->pBuffer);
    const UINT32 ch = channels_;
    out[0]->u32ValidFrameCount = frames;
    out[0]->u32BufferFlags = in[0]->u32BufferFlags;
    if (in[0]->u32BufferFlags != BUFFER_VALID || frames == 0) return;

    const aura::Settings s = load();
    const float target = s.enabled ? 1.0f : 0.0f;
    float peakIn = 0;
    for (UINT32 i = 0; i < frames * ch; i++) peakIn = std::max(peakIn, std::fabs(src[i]));
    raise(gLive.peakIn, peakIn);

    if (frames > capacity_ || (mix_ == 0.0f && target == 0.0f)) {
      if (dst != src) memcpy(dst, src, size_t(frames) * ch * sizeof(float));
      applyMute(dst, frames * ch, s.mute);
      raise(gLive.peakOut, muteGain_ * peakIn);
      measureLoudness(dst, frames, ch);
      return;
    }

    const unsigned csr = _mm_getcsr();
    _mm_setcsr(csr | 0x8040); // flush denormals: reverb tails must not stall the audio thread

    for (UINT32 i = 0; i < frames; i++) {
      float sum = 0;
      for (UINT32 c = 0; c < ch; c++) sum += src[i * ch + c];
      mono_[i] = sum / float(ch);
    }
    if (s.nsStrength > 0.005f) {
      bool deep = false;
#ifdef AURA_HAVE_DFN
      if (s.nsEngine == 1 && deep_.ready()) {
        deep_.process(mono_.data(), int(frames), s.nsStrength);
        gLive.deepFrames.fetch_add(1, std::memory_order_relaxed);
        deep = true;
      }
#endif
      // RNNoise is the fallback whenever the deep engine is not (yet) loaded.
      if (!deep && denoise_.ready()) {
        denoise_.process(mono_.data(), int(frames), aura::denoiseAmount(s.nsStrength), aura::denoiseGateFloor(s.nsStrength));
        raise(gLive.voice, denoise_.voiceProbability());
      }
      gLive.deepActive.store(deep ? 1 : 0, std::memory_order_relaxed);
    }
    if (s.dereverb > 0.005f) dereverb_.process(mono_.data(), int(frames), s.dereverb);
    chain_.setParams(s.params);
    chain_.process(mono_.data(), left_.data(), right_.data(), int(frames));

    // Crossfade between the untouched microphone and the processed voice when toggled.
    const float step = (target - mix_) / float(frames);
    for (UINT32 i = 0; i < frames; i++) {
      mix_ += step;
      const float centre = 0.5f * (left_[i] + right_[i]);
      for (UINT32 c = 0; c < ch; c++) {
        const float dry = src[i * ch + c];
        const float wet = ch == 1 ? centre : c == 0 ? left_[i] : c == 1 ? right_[i] : centre;
        dst[i * ch + c] = dry + (wet - dry) * mix_;
      }
    }
    mix_ = target;
    applyMute(dst, frames * ch, s.mute);
    float peakOut = 0;
    for (UINT32 i = 0; i < frames * ch; i++) peakOut = std::max(peakOut, std::fabs(dst[i]));
    raise(gLive.peakOut, peakOut);
    raise(gLive.reduction, -chain_.gainReductionDb());
    measureLoudness(dst, frames, ch);
    gLive.blocks.fetch_add(1, std::memory_order_relaxed);
    _mm_setcsr(csr);
  }
  STDMETHODIMP_(UINT32) CalcInputFrames(UINT32 outputFrames) override { return outputFrames; }
  STDMETHODIMP_(UINT32) CalcOutputFrames(UINT32 inputFrames) override { return inputFrames; }

 private:
  void leave() {
    AcquireSRWLockExclusive(&gInstancesLock);
    gInstances.erase(std::remove(gInstances.begin(), gInstances.end(), this), gInstances.end());
    ReleaseSRWLockExclusive(&gInstancesLock);
    watchRelease();
  }

  void measureLoudness(const float* samples, UINT32 frames, UINT32 ch) {
    const UINT32 used = ch < 2 ? 1 : 2;
    for (UINT32 i = 0; i < frames; i++) {
      for (UINT32 c = 0; c < used; c++) {
        const float y = kHigh_[c].process(kShelf_[c].process(samples[i * ch + c]));
        meanSquare_[c] += (y * y - meanSquare_[c]) * loudnessCoef_;
      }
    }
    const float sum = meanSquare_[0] + (used == 2 ? meanSquare_[1] : 0.0f);
    gLive.loudness.store(-0.691f + 10.0f * std::log10(sum + 1e-10f), std::memory_order_relaxed);
  }

  // Fade to silence and back over one buffer, so muting never clicks.
  void applyMute(float* samples, UINT32 count, bool mute) {
    const float target = mute ? 0.0f : 1.0f;
    if (muteGain_ == target) {
      if (mute) memset(samples, 0, size_t(count) * sizeof(float));
      return;
    }
    const float step = (target - muteGain_) / float(count);
    for (UINT32 i = 0; i < count; i++) {
      muteGain_ += step;
      samples[i] *= muteGain_;
    }
    muteGain_ = target;
  }

  static HRESULT formatSupported(IAudioMediaType* opposite, IAudioMediaType* requested, IAudioMediaType** supported) {
    if (!requested || !supported) return E_POINTER;
    *supported = nullptr;
    UNCOMPRESSEDAUDIOFORMAT want;
    HRESULT hr = requested->GetUncompressedAudioFormat(&want);
    if (FAILED(hr)) return hr;

    // Input and output must be the same shape: this effect never resamples or remixes.
    if (opposite) {
      UNCOMPRESSEDAUDIOFORMAT other;
      hr = opposite->GetUncompressedAudioFormat(&other);
      if (FAILED(hr)) return hr;
      if (isFloat32(other) && (other.dwSamplesPerFrame != want.dwSamplesPerFrame ||
                               other.fFramesPerSecond != want.fFramesPerSecond || !isFloat32(want))) {
        opposite->AddRef();
        *supported = opposite;
        return S_FALSE;
      }
    }
    if (!isFloat32(want)) return APOERR_FORMAT_NOT_SUPPORTED;
    requested->AddRef();
    *supported = requested;
    return S_OK;
  }

  IUnknown* const outer_;
  std::atomic<long> ref_{1};
  bool locked_ = false;
  UINT32 channels_ = 2;
  UINT32 capacity_ = 0;
  float mix_ = 1.0f;
  float muteGain_ = 1.0f;
  aura::Chain chain_;
  aura::Denoiser denoise_;
  aura::Dereverb dereverb_;
#ifdef AURA_HAVE_DFN
  aura::DeepDenoiser deep_;
#endif
  float sampleRate_ = 48000;
  aura::Biquad kShelf_[2], kHigh_[2];
  float meanSquare_[2] = {0, 0};
  float loudnessCoef_ = 0;
  std::vector<float> mono_, left_, right_;
};

class Factory final : public IClassFactory {
 public:
  STDMETHODIMP QueryInterface(REFIID iid, void** out) override {
    if (!out) return E_POINTER;
    if (iid == __uuidof(IUnknown) || iid == __uuidof(IClassFactory)) {
      *out = this;
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return 2; }  // static lifetime
  STDMETHODIMP_(ULONG) Release() override { return 1; }
  STDMETHODIMP CreateInstance(IUnknown* outer, REFIID iid, void** out) override {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (outer && iid != __uuidof(IUnknown)) return CLASS_E_NOAGGREGATION; // COM rule: an aggregator asks for IUnknown
    AuraApo* apo = new (std::nothrow) AuraApo(outer);
    if (!apo) return E_OUTOFMEMORY;
    const HRESULT hr = apo->NonDelegatingQueryInterface(iid, out);
    apo->NonDelegatingRelease();
    return hr;
  }
  STDMETHODIMP LockServer(BOOL lock) override {
    gObjects += lock ? 1 : -1;
    return S_OK;
  }
};

Factory gFactory;

void loadDeepEverywhere() {
  AcquireSRWLockShared(&gInstancesLock);
  for (AuraApo* apo : gInstances) apo->loadDeep();
  ReleaseSRWLockShared(&gInstancesLock);
}

} // namespace

STDAPI DllGetClassObject(REFCLSID clsid, REFIID iid, void** out) {
  if (!out) return E_POINTER;
  *out = nullptr;
  if (!IsEqualCLSID(clsid, aura::kClsid)) return CLASS_E_CLASSNOTAVAILABLE;
  return gFactory.QueryInterface(iid, out);
}

STDAPI DllCanUnloadNow() { return gObjects.load() == 0 ? S_OK : S_FALSE; }

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, void*) {
  if (reason == DLL_PROCESS_ATTACH) {
    gModule = instance;
    DisableThreadLibraryCalls(instance);
  }
  return TRUE;
}
