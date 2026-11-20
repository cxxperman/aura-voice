// AuraCapture — the sound of one program, and of nothing else.
//
//   AuraCapture <process id>
//
// Uses Windows' process loopback (Windows 10 2004 and later): whatever that process and the
// processes it started are playing, wherever they play it. Writes mono float32 at 48 kHz to
// standard output for as long as it is read; ends when the reader goes away or the program
// being listened to exits. Nothing is written while the program is silent.
#include <windows.h>

#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <fcntl.h>
#include <io.h>
#include <mmdeviceapi.h>

#include <cstdio>
#include <cstdlib>
#include <vector>

// The activation is asynchronous; this receives its result. It has to be callable from any
// thread, which IAgileObject declares.
struct Activation : IActivateAudioInterfaceCompletionHandler, IAgileObject {
  LONG refs = 1;
  HANDLE done = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HRESULT result = E_FAIL;
  IAudioClient* client = nullptr;

  STDMETHODIMP QueryInterface(REFIID iid, void** out) override {
    if (iid == __uuidof(IUnknown) || iid == __uuidof(IActivateAudioInterfaceCompletionHandler)) *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    else if (iid == __uuidof(IAgileObject)) *out = static_cast<IAgileObject*>(this);
    else { *out = nullptr; return E_NOINTERFACE; }
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ULONG(InterlockedIncrement(&refs)); }
  STDMETHODIMP_(ULONG) Release() override { return ULONG(InterlockedDecrement(&refs)); } // lives on the stack of main()
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    IUnknown* unknown = nullptr;
    HRESULT activated = E_FAIL;
    result = operation->GetActivateResult(&activated, &unknown);
    if (SUCCEEDED(result)) result = activated;
    if (SUCCEEDED(result) && unknown) result = unknown->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void**>(&client));
    if (unknown) unknown->Release();
    SetEvent(done);
    return S_OK;
  }
};

static int fail(const char* what, HRESULT hr) {
  std::fprintf(stderr, "%s failed: 0x%08lX\n", what, static_cast<unsigned long>(hr));
  return 1;
}

int main(int argc, char** argv) {
  const DWORD pid = argc > 1 ? DWORD(std::strtoul(argv[1], nullptr, 10)) : 0;
  if (!pid) {
    std::fprintf(stderr, "usage: AuraCapture <process id>\n");
    return 2;
  }
  const HANDLE target = OpenProcess(SYNCHRONIZE, FALSE, pid);
  if (!target) return fail("OpenProcess", HRESULT_FROM_WIN32(GetLastError()));
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return fail("CoInitializeEx", hr);

  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE; // browsers play from child processes
  PROPVARIANT blob = {};
  blob.vt = VT_BLOB;
  blob.blob.cbSize = sizeof(params);
  blob.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  Activation activation;
  IActivateAudioInterfaceAsyncOperation* operation = nullptr;
  hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &blob, &activation, &operation);
  if (FAILED(hr)) return fail("ActivateAudioInterfaceAsync", hr);
  WaitForSingleObject(activation.done, 10000);
  if (operation) operation->Release();
  if (FAILED(activation.result) || !activation.client) return fail("activation", activation.result);
  IAudioClient* client = activation.client;

  // 16-bit stereo at 48 kHz; Windows converts whatever the program plays.
  WAVEFORMATEX format = {};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = 2;
  format.nSamplesPerSec = 48000;
  format.wBitsPerSample = 16;
  format.nBlockAlign = 4;
  format.nAvgBytesPerSec = 48000 * 4;
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                          200000, 0, &format, nullptr);
  if (FAILED(hr)) return fail("IAudioClient::Initialize", hr);
  IAudioCaptureClient* capture = nullptr;
  hr = client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&capture));
  if (FAILED(hr)) return fail("IAudioCaptureClient", hr);
  const HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = client->SetEventHandle(ready);
  if (FAILED(hr)) return fail("SetEventHandle", hr);
  hr = client->Start();
  if (FAILED(hr)) return fail("Start", hr);

  _setmode(_fileno(stdout), _O_BINARY);
  std::fprintf(stderr, "capturing %lu\n", static_cast<unsigned long>(pid));
  std::fflush(stderr);
  std::vector<float> mono;
  const HANDLE waits[2] = {ready, target};
  for (;;) {
    const DWORD woke = WaitForMultipleObjects(2, waits, FALSE, 500);
    if (woke == WAIT_OBJECT_0 + 1) break; // the program being listened to has exited
    UINT32 packet = 0;
    while (SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
      mono.resize(frames);
      const short* in = reinterpret_cast<const short*>(data);
      const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
      for (UINT32 i = 0; i < frames; i++) mono[i] = silent ? 0.0f : (float(in[2 * i]) + float(in[2 * i + 1])) / 65536.0f;
      capture->ReleaseBuffer(frames);
      if (frames && std::fwrite(mono.data(), sizeof(float), frames, stdout) != frames) return 0; // nobody is reading any more
    }
    if (std::fflush(stdout) != 0) return 0;
  }
  client->Stop();
  return 0;
}
