// AuraAPO.dll — an Audio Processing Object that Windows loads into the audio engine
// (audiodg.exe) and runs on every buffer captured from the microphone it is attached to.
// Every program that records from that microphone receives the processed voice.

#include "aura_shared.h"

#include <mmreg.h>
#include <ks.h>
#include <ksmedia.h>
#include <audioenginebaseapo.h>
#include <xmmintrin.h>

#include <atomic>
#include <new>
#include <vector>

namespace {

std::atomic<long> gObjects{0};

// ───── Live settings: written by the watcher thread, read by the real-time thread ─────

struct Live {
  std::atomic<bool> enabled{true};
  std::atomic<float> v[11];
  std::atomic<int> sampleRate{0}, channels{0};
  std::atomic<unsigned> blocks{0};
} gLive;

void store(const aura::Settings& s) {
  const aura::Params& p = s.params;
  const float values[11] = {p.warmth, p.clarity, p.air, p.density, p.width, p.space,
                            p.clean, p.deess, p.autoLevel, p.inGainDb, p.outGainDb};
  for (int i = 0; i < 11; i++) gLive.v[i].store(values[i], std::memory_order_relaxed);
  gLive.enabled.store(s.enabled, std::memory_order_relaxed);
}

aura::Settings load() {
  aura::Settings s;
  aura::Params& p = s.params;
  float* fields[11] = {&p.warmth, &p.clarity, &p.air, &p.density, &p.width, &p.space,
                       &p.clean, &p.deess, &p.autoLevel, &p.inGainDb, &p.outGainDb};
  for (int i = 0; i < 11; i++) *fields[i] = gLive.v[i].load(std::memory_order_relaxed);
  s.enabled = gLive.enabled.load(std::memory_order_relaxed);
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
  char text[160];
  const int len = wsprintfA(text, "alive=1\r\nsr=%d\r\nch=%d\r\nblocks=%u\r\nenabled=%d\r\n", gLive.sampleRate.load(),
                            gLive.channels.load(), gLive.blocks.load(), gLive.enabled.load() ? 1 : 0);
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
    if (tick % 5 == 0) writeStatus(status);
    if (WaitForSingleObject(gWatchStop, 200) == WAIT_OBJECT_0) break;
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

class AuraApo final : public IAudioProcessingObject,
                      public IAudioProcessingObjectRT,
                      public IAudioProcessingObjectConfiguration,
                      public IAudioSystemEffects {
 public:
  AuraApo() { gObjects++; }
  ~AuraApo() {
    if (locked_) watchRelease();
    gObjects--;
  }

  // IUnknown
  STDMETHODIMP QueryInterface(REFIID iid, void** out) override {
    if (!out) return E_POINTER;
    if (iid == __uuidof(IUnknown) || iid == __uuidof(IAudioProcessingObject)) *out = static_cast<IAudioProcessingObject*>(this);
    else if (iid == __uuidof(IAudioProcessingObjectRT)) *out = static_cast<IAudioProcessingObjectRT*>(this);
    else if (iid == __uuidof(IAudioProcessingObjectConfiguration)) *out = static_cast<IAudioProcessingObjectConfiguration*>(this);
    else if (iid == __uuidof(IAudioSystemEffects)) *out = static_cast<IAudioSystemEffects*>(this);
    else { *out = nullptr; return E_NOINTERFACE; }
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ULONG(++ref_); }
  STDMETHODIMP_(ULONG) Release() override {
    const long left = --ref_;
    if (left == 0) delete this;
    return ULONG(left);
  }

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
    if (locked_) return APOERR_ALREADY_LOCKED;
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
    } catch (const std::bad_alloc&) {
      return E_OUTOFMEMORY;
    }
    gLive.sampleRate = int(f.fFramesPerSecond);
    gLive.channels = int(channels_);
    watchAcquire();
    mix_ = gLive.enabled.load() ? 1.0f : 0.0f;
    locked_ = true;
    return S_OK;
  }
  STDMETHODIMP UnlockForProcess() override {
    if (!locked_) return APOERR_ALREADY_UNLOCKED;
    locked_ = false;
    watchRelease();
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
    if (frames > capacity_ || (mix_ == 0.0f && target == 0.0f)) {
      if (dst != src) memcpy(dst, src, size_t(frames) * ch * sizeof(float));
      return;
    }

    const unsigned csr = _mm_getcsr();
    _mm_setcsr(csr | 0x8040); // flush denormals: reverb tails must not stall the audio thread

    for (UINT32 i = 0; i < frames; i++) {
      float sum = 0;
      for (UINT32 c = 0; c < ch; c++) sum += src[i * ch + c];
      mono_[i] = sum / float(ch);
    }
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
    gLive.blocks.fetch_add(1, std::memory_order_relaxed);
    _mm_setcsr(csr);
  }
  STDMETHODIMP_(UINT32) CalcInputFrames(UINT32 outputFrames) override { return outputFrames; }
  STDMETHODIMP_(UINT32) CalcOutputFrames(UINT32 inputFrames) override { return inputFrames; }

 private:
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

  std::atomic<long> ref_{1};
  bool locked_ = false;
  UINT32 channels_ = 2;
  UINT32 capacity_ = 0;
  float mix_ = 1.0f;
  aura::Chain chain_;
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
    if (outer) return CLASS_E_NOAGGREGATION;
    AuraApo* apo = new (std::nothrow) AuraApo();
    if (!apo) return E_OUTOFMEMORY;
    const HRESULT hr = apo->QueryInterface(iid, out);
    apo->Release();
    return hr;
  }
  STDMETHODIMP LockServer(BOOL lock) override {
    gObjects += lock ? 1 : -1;
    return S_OK;
  }
};

Factory gFactory;

} // namespace

STDAPI DllGetClassObject(REFCLSID clsid, REFIID iid, void** out) {
  if (!out) return E_POINTER;
  *out = nullptr;
  if (!IsEqualCLSID(clsid, aura::kClsid)) return CLASS_E_CLASSNOTAVAILABLE;
  return gFactory.QueryInterface(iid, out);
}

STDAPI DllCanUnloadNow() { return gObjects.load() == 0 ? S_OK : S_FALSE; }

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, void*) {
  if (reason == DLL_PROCESS_ATTACH) DisableThreadLibraryCalls(instance);
  return TRUE;
}
