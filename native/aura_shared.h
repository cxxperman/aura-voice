// Things the APO module, the installer and the Aura window all have to agree on.
#pragma once

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <cstdlib>
#include <cstring>
#include <string>

#include "aura_dsp.h"

namespace aura {

// {7C1D5A62-3F0E-4B7A-9E2B-A0D3C4F51E88}
constexpr GUID kClsid = {0x7c1d5a62, 0x3f0e, 0x4b7a, {0x9e, 0x2b, 0xa0, 0xd3, 0xc4, 0xf5, 0x1e, 0x88}};
constexpr wchar_t kClsidString[] = L"{7C1D5A62-3F0E-4B7A-9E2B-A0D3C4F51E88}";
constexpr wchar_t kFriendlyName[] = L"Aura Voice";
constexpr wchar_t kCopyright[] = L"Aura";

// %ProgramData%\Aura — the window writes settings.txt, the module answers with status.txt.
inline std::wstring dataDir() {
  wchar_t buf[MAX_PATH];
  const DWORD n = GetEnvironmentVariableW(L"ProgramData", buf, MAX_PATH);
  return (n > 0 && n < MAX_PATH ? std::wstring(buf) : std::wstring(L"C:\\ProgramData")) + L"\\Aura";
}

struct Settings {
  bool enabled = true;
  bool mute = false;      // hard mute of the microphone, wins over everything
  float nsStrength = 0;   // neural noise suppression, 0 = off .. 1 = maximum
  float dereverb = 0;     // room-echo reduction, 0 = off .. 1 = maximum
  Params params;
};

// "key=value" per line, applied on top of `s`. Unknown keys and garbage are ignored, every value is clamped:
// this text is writable by ordinary users and is read inside the audio service.
inline Settings parseSettings(const char* text, Settings s = Settings()) {
  auto clamp = [](double v, double lo, double hi) { return float(v < lo ? lo : v > hi ? hi : v); };
  const char* p = text;
  while (*p) {
    const char* eol = std::strchr(p, '\n');
    const size_t len = eol ? size_t(eol - p) : std::strlen(p);
    const std::string line(p, len);
    p += len + (eol ? 1 : 0);

    const size_t eq = line.find('=');
    if (eq == std::string::npos) continue;
    const std::string key = line.substr(0, eq);
    char* end = nullptr;
    const double v = std::strtod(line.c_str() + eq + 1, &end);
    if (end == line.c_str() + eq + 1 || v != v) continue;

    if (key == "enabled") s.enabled = v > 0.5;
    else if (key == "mute") s.mute = v > 0.5;
    else if (key == "ns") s.nsStrength = clamp(v / 100, 0, 1);
    else if (key == "pop") s.params.pop = clamp(v / 100, 0, 1);
    else if (key == "pitch") s.params.pitch = clamp(v, -12, 12);
    else if (key == "dereverb") s.dereverb = clamp(v / 100, 0, 1);
    else if (key == "warmth") s.params.warmth = clamp(v / 100, 0, 1);
    else if (key == "clarity") s.params.clarity = clamp(v / 100, 0, 1);
    else if (key == "air") s.params.air = clamp(v / 100, 0, 1);
    else if (key == "density") s.params.density = clamp(v / 100, 0, 1);
    else if (key == "width") s.params.width = clamp(v / 100, 0, 1);
    else if (key == "space") s.params.space = clamp(v / 100, 0, 1);
    else if (key == "clean") s.params.clean = clamp(v / 100, 0, 1);
    else if (key == "deess") s.params.deess = clamp(v / 100, 0, 1);
    else if (key == "auto") s.params.autoLevel = v > 0.5 ? 1.0f : 0.0f;
    else if (key == "ingain") s.params.inGainDb = clamp(v, -24, 24);
    else if (key == "outgain") s.params.outGainDb = clamp(v, -24, 12);
  }
  return s;
}

} // namespace aura
