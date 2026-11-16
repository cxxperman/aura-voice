// AuraSetup.exe — attaches AuraAPO.dll to a microphone, and takes it off again.
//
//   AuraSetup install [--device {endpoint-guid}] [--unprotect]
//   AuraSetup uninstall
//
// Needs administrator rights (the manifest asks for them). Everything it does is written
// to %ProgramData%\Aura\setup.log so the Aura window can show the outcome.

#include "aura_shared.h"

#include <mmdeviceapi.h>
#include <audioenginebaseapo.h>
#include <sddl.h>

#include <cstdio>
#include <string>
#include <vector>

namespace {

const wchar_t kCaptureRoot[] = L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Capture\\";
const wchar_t kApoRoot[] = L"SOFTWARE\\Classes\\AudioEngine\\AudioProcessingObjects\\";
const wchar_t kClsidRoot[] = L"SOFTWARE\\Classes\\CLSID\\";
const wchar_t kAuraKey[] = L"SOFTWARE\\Aura";
const wchar_t kAudioKey[] = L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Audio";
// Legacy "post-mix" effect slot — the one Clownfish uses on capture devices.
const wchar_t kFxSlot[] = L"{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},2";
const wchar_t kFxDisable[] = L"{1da5d803-d492-4edd-8c23-e0c0ffee7f0e},5";

std::vector<std::wstring> gLog;

void say(const std::wstring& line) {
  gLog.push_back(line);
  wprintf(L"%ls\n", line.c_str());
}

std::string utf8(const std::wstring& w) {
  if (w.empty()) return {};
  std::string out(size_t(WideCharToMultiByte(CP_UTF8, 0, w.data(), int(w.size()), nullptr, 0, nullptr, nullptr)), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), int(w.size()), out.data(), int(out.size()), nullptr, nullptr);
  return out;
}

void writeFile(const std::wstring& path, const std::string& bytes) {
  const HANDLE f = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (f == INVALID_HANDLE_VALUE) return;
  DWORD put = 0;
  WriteFile(f, bytes.data(), DWORD(bytes.size()), &put, nullptr);
  CloseHandle(f);
}

void flushLog(bool ok) {
  std::string text = ok ? "result=ok\r\n" : "result=error\r\n";
  for (const auto& line : gLog) text += utf8(line) + "\r\n";
  writeFile(aura::dataDir() + L"\\setup.log", text);
}

bool enablePrivilege(const wchar_t* name) {
  HANDLE token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &token)) return false;
  TOKEN_PRIVILEGES tp = {};
  tp.PrivilegeCount = 1;
  tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
  const bool ok = LookupPrivilegeValueW(nullptr, name, &tp.Privileges[0].Luid) &&
                  AdjustTokenPrivileges(token, FALSE, &tp, 0, nullptr, nullptr) && GetLastError() == ERROR_SUCCESS;
  CloseHandle(token);
  return ok;
}

// The endpoint keys are locked down even for administrators; backup/restore semantics get past the ACL.
HKEY openKey(const std::wstring& path, bool create) {
  HKEY key = nullptr;
  if (create) {
    RegCreateKeyExW(HKEY_LOCAL_MACHINE, path.c_str(), 0, nullptr, REG_OPTION_BACKUP_RESTORE, KEY_ALL_ACCESS | KEY_WOW64_64KEY,
                    nullptr, &key, nullptr);
  } else {
    RegOpenKeyExW(HKEY_LOCAL_MACHINE, path.c_str(), REG_OPTION_BACKUP_RESTORE, KEY_ALL_ACCESS | KEY_WOW64_64KEY, &key);
  }
  return key;
}

bool setString(HKEY key, const wchar_t* name, const std::wstring& value) {
  return RegSetValueExW(key, name, 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()),
                        DWORD((value.size() + 1) * sizeof(wchar_t))) == ERROR_SUCCESS;
}
bool setDword(HKEY key, const wchar_t* name, DWORD value) {
  return RegSetValueExW(key, name, 0, REG_DWORD, reinterpret_cast<const BYTE*>(&value), sizeof(value)) == ERROR_SUCCESS;
}
bool getString(HKEY key, const wchar_t* name, std::wstring& out) {
  wchar_t buf[512];
  DWORD size = sizeof(buf) - sizeof(wchar_t), type = 0;
  if (RegQueryValueExW(key, name, nullptr, &type, reinterpret_cast<BYTE*>(buf), &size) != ERROR_SUCCESS) return false;
  if (type != REG_SZ && type != REG_EXPAND_SZ) return false;
  buf[size / sizeof(wchar_t)] = 0;
  out = buf;
  return true;
}
bool getDword(HKEY key, const wchar_t* name, DWORD& out) {
  DWORD size = sizeof(out), type = 0;
  return RegQueryValueExW(key, name, nullptr, &type, reinterpret_cast<BYTE*>(&out), &size) == ERROR_SUCCESS && type == REG_DWORD;
}

std::wstring installDir() {
  wchar_t buf[MAX_PATH];
  const DWORD n = GetEnvironmentVariableW(L"ProgramW6432", buf, MAX_PATH);
  if (n == 0 || n >= MAX_PATH) GetEnvironmentVariableW(L"ProgramFiles", buf, MAX_PATH);
  return std::wstring(buf) + L"\\Aura";
}

std::wstring exeDir() {
  wchar_t buf[MAX_PATH];
  GetModuleFileNameW(nullptr, buf, MAX_PATH);
  std::wstring path(buf);
  return path.substr(0, path.find_last_of(L'\\'));
}

// "{0.0.1.00000000}.{guid}" → "{guid}"
std::wstring defaultCaptureGuid() {
  std::wstring guid;
  IMMDeviceEnumerator* enumerator = nullptr;
  if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                 reinterpret_cast<void**>(&enumerator)))) {
    IMMDevice* device = nullptr;
    if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &device))) {
      LPWSTR id = nullptr;
      if (SUCCEEDED(device->GetId(&id))) {
        const std::wstring full(id);
        const size_t dot = full.find_last_of(L'.');
        if (dot != std::wstring::npos) guid = full.substr(dot + 1);
        CoTaskMemFree(id);
      }
      device->Release();
    }
    enumerator->Release();
  }
  return guid;
}

std::wstring deviceName(const std::wstring& guid) {
  std::wstring name = guid, part;
  HKEY key = nullptr;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, (kCaptureRoot + guid + L"\\Properties").c_str(), 0, KEY_READ | KEY_WOW64_64KEY, &key) ==
      ERROR_SUCCESS) {
    if (getString(key, L"{a45c254e-df1c-4efd-8020-67d146a850e0},2", part)) name = part;
    if (getString(key, L"{b3f8fa53-0004-438e-9003-51a46e139bfc},6", part)) name += L" (" + part + L")";
    RegCloseKey(key);
  }
  return name;
}

void audioService(bool start) {
  _wsystem(start ? L"net start audiosrv >nul 2>&1" : L"net stop audiosrv /y >nul 2>&1");
}

// %ProgramData%\Aura: users may change settings, the audio service (LOCAL SERVICE) may write its status.
bool makeDataDir() {
  const std::wstring dir = aura::dataDir();
  PSECURITY_DESCRIPTOR sd = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          L"D:P(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;0x1301bf;;;BU)(A;OICI;0x1301bf;;;LS)", SDDL_REVISION_1, &sd, nullptr)) {
    return false;
  }
  SECURITY_ATTRIBUTES sa = {sizeof(sa), sd, FALSE};
  bool ok = CreateDirectoryW(dir.c_str(), &sa) != 0;
  if (!ok && GetLastError() == ERROR_ALREADY_EXISTS) {
    ok = SetFileSecurityW(dir.c_str(), DACL_SECURITY_INFORMATION, sd) != 0;
  }
  LocalFree(sd);
  return ok;
}

// Take Aura out of one microphone's effect slot, putting back whatever was there before.
void detach(const std::wstring& guid) {
  HKEY fx = openKey(kCaptureRoot + guid + L"\\FxProperties", false);
  if (!fx) return;
  std::wstring current;
  if (getString(fx, kFxSlot, current) && _wcsicmp(current.c_str(), aura::kClsidString) == 0) {
    std::wstring previous;
    HKEY aura = openKey(kAuraKey, false);
    const bool hadPrevious = aura && getString(aura, L"PreviousEffect", previous) && !previous.empty();
    if (aura) RegCloseKey(aura);
    if (hadPrevious) setString(fx, kFxSlot, previous);
    else RegDeleteValueW(fx, kFxSlot);
    say(L"Модуль снят с микрофона: " + deviceName(guid));
  }
  RegCloseKey(fx);
}

int install(std::wstring guid, bool unprotect) {
  if (guid.empty()) guid = defaultCaptureGuid();
  if (guid.empty()) {
    say(L"Не найден микрофон по умолчанию. Подключите микрофон и повторите.");
    return 1;
  }
  HKEY device = nullptr;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, (kCaptureRoot + guid).c_str(), 0, KEY_READ | KEY_WOW64_64KEY, &device) != ERROR_SUCCESS) {
    say(L"Устройство записи не найдено: " + guid);
    return 1;
  }
  RegCloseKey(device);

  const std::wstring source = exeDir() + L"\\AuraAPO.dll";
  const std::wstring dir = installDir();
  const std::wstring target = dir + L"\\AuraAPO.dll";
  if (GetFileAttributesW(source.c_str()) == INVALID_FILE_ATTRIBUTES) {
    say(L"Рядом с установщиком нет файла AuraAPO.dll.");
    return 1;
  }

  // If Aura already sits on another microphone, move it rather than stack it.
  HKEY aura = openKey(kAuraKey, true);
  std::wstring oldGuid;
  if (aura && getString(aura, L"Device", oldGuid) && _wcsicmp(oldGuid.c_str(), guid.c_str()) != 0) detach(oldGuid);

  audioService(false); // releases the DLL if an older copy is loaded
  CreateDirectoryW(dir.c_str(), nullptr);
  if (!CopyFileW(source.c_str(), target.c_str(), FALSE)) {
    say(L"Не удалось скопировать модуль в " + dir + L" (ошибка " + std::to_wstring(GetLastError()) + L").");
    audioService(true);
    return 1;
  }

  bool ok = true;
  const std::wstring clsid = aura::kClsidString;

  // 1. The COM class.
  if (HKEY k = openKey(kClsidRoot + clsid, true)) {
    ok &= setString(k, nullptr, aura::kFriendlyName);
    RegCloseKey(k);
  } else ok = false;
  if (HKEY k = openKey(kClsidRoot + clsid + L"\\InprocServer32", true)) {
    ok &= setString(k, nullptr, target);
    ok &= setString(k, L"ThreadingModel", L"Both");
    RegCloseKey(k);
  } else ok = false;

  // 2. The entry in the audio engine's list of processing objects.
  if (HKEY k = openKey(kApoRoot + clsid, true)) {
    wchar_t iid[64];
    StringFromGUID2(__uuidof(IAudioProcessingObject), iid, 64);
    ok &= setString(k, L"FriendlyName", aura::kFriendlyName);
    ok &= setString(k, L"Copyright", aura::kCopyright);
    ok &= setDword(k, L"MajorVersion", 1);
    ok &= setDword(k, L"MinorVersion", 0);
    ok &= setDword(k, L"Flags", APO_FLAG_DEFAULT | APO_FLAG_INPLACE);
    ok &= setDword(k, L"MinInputConnections", 1);
    ok &= setDword(k, L"MaxInputConnections", 1);
    ok &= setDword(k, L"MinOutputConnections", 1);
    ok &= setDword(k, L"MaxOutputConnections", 1);
    ok &= setDword(k, L"MaxInstances", 0xffffffff);
    ok &= setDword(k, L"NumAPOInterfaces", 1);
    ok &= setString(k, L"APOInterface0", iid);
    RegCloseKey(k);
  } else ok = false;

  // 3. The microphone's effect slot.
  if (HKEY fx = openKey(kCaptureRoot + guid + L"\\FxProperties", true)) {
    std::wstring previous;
    const bool had = getString(fx, kFxSlot, previous) && _wcsicmp(previous.c_str(), clsid.c_str()) != 0 &&
                     previous != L"{00000000-0000-0000-0000-000000000000}";
    if (aura && _wcsicmp(oldGuid.c_str(), guid.c_str()) != 0) setString(aura, L"PreviousEffect", had ? previous : L"");
    ok &= setString(fx, kFxSlot, clsid);
    setDword(fx, kFxDisable, 0); // "audio enhancements" must stay on for the slot to run
    RegCloseKey(fx);
    if (had) say(L"В слоте эффектов уже стоял другой модуль (" + previous + L") — он сохранён и вернётся при удалении Aura.");
  } else ok = false;

  if (aura) {
    setString(aura, L"Device", guid);
    setString(aura, L"InstallDir", dir);
  }

  // 4. Optional: let the audio engine load a module without a commercial signature.
  if (unprotect) {
    if (HKEY k = openKey(kAudioKey, true)) {
      DWORD before = 0;
      const bool existed = getDword(k, L"DisableProtectedAudioDG", before);
      DWORD marker = 0;
      if (aura && !getDword(aura, L"ChangedProtection", marker)) {
        setDword(aura, L"ChangedProtection", 1);
        setDword(aura, L"ProtectionExisted", existed ? 1 : 0);
        setDword(aura, L"ProtectionBefore", before);
      }
      ok &= setDword(k, L"DisableProtectedAudioDG", 1);
      RegCloseKey(k);
      say(L"Защищённый режим звукового процесса отключён (DisableProtectedAudioDG=1).");
    } else ok = false;
  }
  if (aura) RegCloseKey(aura);

  if (!makeDataDir()) say(L"Предупреждение: не удалось настроить папку " + aura::dataDir());
  const std::wstring settings = aura::dataDir() + L"\\settings.txt";
  if (GetFileAttributesW(settings.c_str()) == INVALID_FILE_ATTRIBUTES) writeFile(settings, "enabled=1\r\n");

  audioService(true);

  if (!ok) {
    say(L"Не все записи реестра удалось сделать. Запустите удаление и попробуйте снова.");
    return 1;
  }
  say(L"Aura встроена в микрофон: " + deviceName(guid));
  say(L"device=" + guid);
  return 0;
}

int uninstall() {
  HKEY aura = openKey(kAuraKey, false);
  std::wstring guid, dir = installDir();
  if (aura) {
    getString(aura, L"Device", guid);
    getString(aura, L"InstallDir", dir);
  }
  if (!guid.empty()) detach(guid);

  DWORD changed = 0;
  if (aura && getDword(aura, L"ChangedProtection", changed) && changed) {
    if (HKEY k = openKey(kAudioKey, false)) {
      DWORD existed = 0, before = 0;
      getDword(aura, L"ProtectionExisted", existed);
      getDword(aura, L"ProtectionBefore", before);
      if (existed) setDword(k, L"DisableProtectedAudioDG", before);
      else RegDeleteValueW(k, L"DisableProtectedAudioDG");
      RegCloseKey(k);
      say(L"Защищённый режим звукового процесса возвращён как был.");
    }
  }
  if (aura) RegCloseKey(aura);

  audioService(false);
  const std::wstring clsid = aura::kClsidString;
  RegDeleteTreeW(HKEY_LOCAL_MACHINE, (kApoRoot + clsid).c_str());
  RegDeleteTreeW(HKEY_LOCAL_MACHINE, (kClsidRoot + clsid).c_str());
  RegDeleteTreeW(HKEY_LOCAL_MACHINE, kAuraKey);
  DeleteFileW((dir + L"\\AuraAPO.dll").c_str());
  RemoveDirectoryW(dir.c_str());
  DeleteFileW((aura::dataDir() + L"\\status.txt").c_str());
  audioService(true);

  say(L"Aura удалена из системы. Микрофон работает как раньше.");
  return 0;
}

} // namespace

int wmain(int argc, wchar_t** argv) {
  std::wstring command = argc > 1 ? argv[1] : L"";
  std::wstring guid;
  bool unprotect = false;
  for (int i = 2; i < argc; i++) {
    const std::wstring arg = argv[i];
    if (arg == L"--device" && i + 1 < argc) guid = argv[++i];
    else if (arg == L"--unprotect") unprotect = true;
  }

  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  makeDataDir();
  int code = 2;
  if (!enablePrivilege(SE_BACKUP_NAME) || !enablePrivilege(SE_RESTORE_NAME)) {
    say(L"Нужны права администратора.");
  } else if (command == L"install") {
    code = install(guid, unprotect);
  } else if (command == L"uninstall") {
    code = uninstall();
  } else {
    say(L"Использование: AuraSetup install [--device {guid}] [--unprotect] | AuraSetup uninstall");
  }
  flushLog(code == 0);
  CoUninitialize();
  return code;
}
