// Offline check of the voice chain: feeds it a synthetic "voice" and makes sure the result is sane.
#include "aura_shared.h"
#include "aura_denoise.h"

#include <chrono>
#include <cstdio>
#include <vector>

static int failures = 0;
#define CHECK(cond, ...)                         \
  do {                                           \
    if (!(cond)) {                               \
      failures++;                                \
      std::printf("  FAIL: " __VA_ARGS__);       \
      std::printf("\n");                         \
    }                                            \
  } while (0)

static float rmsDb(const std::vector<float>& x, size_t from, size_t to) {
  double sum = 0;
  for (size_t i = from; i < to; i++) sum += double(x[i]) * x[i];
  return float(10.0 * std::log10(sum / double(to - from) + 1e-12));
}

// 0.5 s room noise · 1.5 s of syllables with one sharp "s" · 1 s room noise.
static std::vector<float> voice(float sr) {
  std::vector<float> x(size_t(3.0f * sr));
  unsigned seed = 12345;
  float hp = 0;
  for (size_t i = 0; i < x.size(); i++) {
    const float t = float(i) / sr;
    seed = seed * 1664525u + 1013904223u;
    const float noise = float(seed >> 8) / 8388608.0f - 1.0f;
    float s = noise * 0.001f;
    if (t >= 0.5f && t < 2.0f) {
      float saw = 0;
      for (int k = 1; k <= 20 && 140.0f * k < 0.45f * sr; k++) saw += std::sin(2 * aura::kPi * 140.0f * k * t) / float(k);
      s += saw * 0.08f * (0.55f + 0.45f * std::sin(2 * aura::kPi * 4.0f * t));
      if (t >= 1.0f && t < 1.1f) { s += (noise - hp) * 0.2f; }
    }
    hp += (noise - hp) * 0.3f;
    x[i] = s;
  }
  return x;
}

static void run(const char* name, float sr, const aura::Params& p, bool expectGate) {
  const std::vector<float> in = voice(sr);
  std::vector<float> l(in.size()), r(in.size());
  aura::Chain chain;
  chain.prepare(sr);
  chain.setParams(p);
  const int block = int(sr / 100);
  const auto t0 = std::chrono::steady_clock::now();
  for (size_t at = 0; at < in.size(); at += size_t(block)) {
    const int n = int(std::min(size_t(block), in.size() - at));
    chain.process(in.data() + at, l.data() + at, r.data() + at, n);
  }
  const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();

  float peak = 0;
  bool finite = true;
  for (size_t i = 0; i < in.size(); i++) {
    finite = finite && std::isfinite(l[i]) && std::isfinite(r[i]);
    peak = std::max(peak, std::max(std::fabs(l[i]), std::fabs(r[i])));
  }
  const size_t a = size_t(0.7f * sr), b = size_t(1.9f * sr), tail = size_t(2.7f * sr);
  const float speechIn = rmsDb(in, a, b), speechOut = rmsDb(l, a, b);
  const float quietIn = rmsDb(in, tail, in.size()), quietOut = rmsDb(l, tail, in.size());
  std::printf("%-22s sr=%-6.0f speech %6.1f -> %6.1f dB | pause %6.1f -> %6.1f dB | peak %.3f | %.1f%% of realtime\n", name, sr,
              speechIn, speechOut, quietIn, quietOut, peak, ms / 3000.0 * 100.0);

  CHECK(finite, "output contains NaN or infinity");
  CHECK(peak <= 1.0f, "peak %.3f exceeds full scale", peak);
  CHECK(speechOut > speechIn - 6.0f, "voice got much quieter (%.1f dB)", speechOut - speechIn);
  CHECK(speechOut < -3.0f, "voice is pinned to the ceiling (%.1f dB RMS)", speechOut);
  CHECK(ms < 600.0, "too slow: %.0f ms for 3 s of audio", ms);
  if (expectGate) CHECK(quietOut < quietIn - 6.0f, "pauses are not quieter (%.1f dB vs %.1f dB)", quietOut, quietIn);
}

// Voice in a loud fan-like hiss (-41 dB RMS): the pauses must come out much cleaner, the voice must survive.
static void runDenoiser() {
  std::vector<float> x = voice(48000);
  unsigned seed = 777;
  for (auto& s : x) {
    seed = seed * 1664525u + 1013904223u;
    s += (float(seed >> 8) / 8388608.0f - 1.0f) * 0.015f;
  }
  const std::vector<float> in = x;
  aura::Denoiser d;
  CHECK(d.prepare(48000), "denoiser did not start at 48 kHz");
  CHECK(!aura::Denoiser().prepare(44100), "denoiser must refuse 44.1 kHz");
  const auto t0 = std::chrono::steady_clock::now();
  for (size_t at = 0; at < x.size(); at += 441) d.process(x.data() + at, int(std::min<size_t>(441, x.size() - at)), 1.0f);
  const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();

  bool finite = true;
  for (float s : x) finite = finite && std::isfinite(s);
  const size_t a = size_t(0.7f * 48000), b = size_t(1.9f * 48000), tail = size_t(2.5f * 48000);
  const float speechIn = rmsDb(in, a, b), speechOut = rmsDb(x, a, b);
  const float quietIn = rmsDb(in, tail, in.size()), quietOut = rmsDb(x, tail, in.size());
  std::printf("%-22s sr=48000  speech %6.1f -> %6.1f dB | pause %6.1f -> %6.1f dB | %.1f%% of realtime\n", "noise suppression",
              speechIn, speechOut, quietIn, quietOut, ms / 3000.0 * 100.0);
  CHECK(finite, "denoiser output contains NaN or infinity");
  CHECK(quietOut < quietIn - 10.0f, "noise in pauses only dropped by %.1f dB", quietIn - quietOut);
  CHECK(speechOut > speechIn - 9.0f, "denoiser ate the voice (%.1f dB)", speechOut - speechIn);
  CHECK(ms < 600.0, "denoiser too slow: %.0f ms for 3 s", ms);
}

int main() {
  runDenoiser();
  aura::Params def;
  aura::Params zero = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
  aura::Params max = {1, 1, 1, 1, 1, 1, 1, 1, 1, 12, 0};
  for (float sr : {48000.0f, 44100.0f, 16000.0f, 96000.0f}) {
    run("default", sr, def, true);
    run("everything off", sr, zero, false);
    run("everything at maximum", sr, max, false);
  }

  const aura::Settings s = aura::parseSettings("enabled=0\r\nwarmth=80\r\nfoo=1\r\nair=abc\r\ningain=99\r\n=5\r\nwidth=-3\r\n");
  CHECK(!s.enabled, "enabled=0 was not parsed");
  CHECK(std::fabs(s.params.warmth - 0.8f) < 1e-5f, "warmth=%f", s.params.warmth);
  CHECK(std::fabs(s.params.air - aura::Params().air) < 1e-5f, "garbage changed air to %f", s.params.air);
  CHECK(s.params.inGainDb == 24.0f, "ingain was not clamped: %f", s.params.inGainDb);
  CHECK(s.params.width == 0.0f, "width was not clamped: %f", s.params.width);

  std::printf(failures ? "\n%d check(s) FAILED\n" : "\nall checks passed\n", failures);
  return failures ? 1 : 0;
}
