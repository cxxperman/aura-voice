// Offline check of the voice chain: feeds it a synthetic "voice" and makes sure the result is sane.
#include "aura_shared.h"
#include "aura_denoise.h"
#include "aura_dereverb.h"
#ifdef AURA_HAVE_DFN
#include "aura_dfn.h"
#endif

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
  for (size_t at = 0; at < x.size(); at += 441) d.process(x.data() + at, int(std::min<size_t>(441, x.size() - at)), 1.0f, 1.0f);
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

  // Maximum strength adds the voice gate: pauses must drop further, and the voice must not be chopped.
  std::vector<float> y = in;
  aura::Denoiser g;
  g.prepare(48000);
  for (size_t at = 0; at < y.size(); at += 480) {
    g.process(y.data() + at, int(std::min<size_t>(480, y.size() - at)), aura::denoiseAmount(1.0f), aura::denoiseGateFloor(1.0f));
  }
  const float gatedSpeech = rmsDb(y, a, b), gatedQuiet = rmsDb(y, tail, in.size());
  std::printf("%-22s sr=48000  speech %6.1f -> %6.1f dB | pause %6.1f -> %6.1f dB\n", "  + voice gate", speechIn, gatedSpeech, quietIn, gatedQuiet);
  CHECK(gatedQuiet <= quietOut + 0.5f, "voice gate made pauses louder (%.1f vs %.1f dB)", gatedQuiet, quietOut);
  CHECK(gatedSpeech > speechOut - 3.0f, "voice gate chopped the voice (%.1f dB vs %.1f dB)", gatedSpeech, speechOut);
  CHECK(aura::denoiseAmount(0.31f) > 0.49f && aura::denoiseAmount(0.31f) < 0.51f && aura::denoiseGateFloor(0.5f) == 1.0f,
        "strength mapping is off");
}

// A 200 Hz tone shifted up four semitones must come out near 252 Hz.
static void runPitch() {
  aura::PitchShifter shifter;
  shifter.prepare(48000);
  const float ratio = std::pow(2.0f, 4.0f / 12.0f);
  int crossings = 0;
  float prev = 0, peak = 0;
  for (int i = 0; i < 96000; i++) {
    const float y = shifter.process(0.5f * std::sin(2 * aura::kPi * 200.0f * float(i) / 48000.0f), ratio);
    if (i >= 48000) {
      if (prev <= 0 && y > 0) crossings++;
      peak = std::max(peak, std::fabs(y));
    }
    prev = y;
  }
  std::printf("%-22s 200 Hz +4 semitones -> %d Hz (expected 252), peak %.2f\n", "pitch", crossings, peak);
  CHECK(crossings > 240 && crossings < 264, "pitch shifter produced %d Hz", crossings);
  CHECK(peak > 0.3f && peak < 0.6f, "pitch shifter changed the level: peak %.2f", peak);
}

// Tone bursts in a reverberant room (T60 0.6 s): the gaps between bursts must get drier, the bursts must stay.
static void runDereverb() {
  const int sr = 48000;
  std::vector<float> dry(size_t(sr) * 4, 0.0f);
  for (size_t i = 0; i < dry.size(); i++) {
    const float t = float(i) / sr;
    if (std::fmod(t, 0.6f) < 0.2f) {
      for (int k = 1; k <= 12; k++) dry[i] += 0.04f * std::sin(2 * aura::kPi * 150.0f * k * t) / std::sqrt(float(k));
    }
  }
  std::vector<float> ir(size_t(0.6f * sr), 0.0f);
  unsigned seed = 4242;
  for (size_t i = size_t(0.01f * sr); i < ir.size(); i++) {
    seed = seed * 1664525u + 1013904223u;
    ir[i] = (float(seed >> 8) / 8388608.0f - 1.0f) * 0.02f * std::exp(-6.9f * float(i) / float(ir.size()));
  }
  std::vector<float> wet(dry.size(), 0.0f);
  for (size_t i = 0; i < dry.size(); i++) {
    if (dry[i] == 0.0f) continue;
    wet[i] += dry[i];
    for (size_t j = size_t(0.01f * sr); j < ir.size() && i + j < wet.size(); j += 2) wet[i + j] += dry[i] * ir[j] * 2.0f;
  }
  std::vector<float> out = wet;
  aura::Dereverb d;
  d.prepare(float(sr));
  for (size_t at = 0; at < out.size(); at += 480) d.process(out.data() + at, 480, 1.0f);
  const int lag = d.latencySamples();

  auto energy = [&](const std::vector<float>& x, int shift, bool bursts) {
    double sum = 0;
    size_t count = 0;
    for (size_t i = size_t(sr); i + size_t(shift) < x.size(); i++) {
      const float phase = std::fmod(float(i) / sr, 0.6f);
      const bool inBurst = phase > 0.03f && phase < 0.19f, inGap = phase > 0.30f && phase < 0.58f;
      if (bursts ? inBurst : inGap) {
        sum += double(x[i + size_t(shift)]) * x[i + size_t(shift)];
        count++;
      }
    }
    return float(10.0 * std::log10(sum / double(count) + 1e-12));
  };
  bool finite = true;
  for (float s : out) finite = finite && std::isfinite(s);
  const float burstIn = energy(wet, 0, true), burstOut = energy(out, lag, true);
  const float gapIn = energy(wet, 0, false), gapOut = energy(out, lag, false);
  std::printf("%-22s bursts %6.1f -> %6.1f dB | reverb tails %6.1f -> %6.1f dB | latency %.1f ms\n", "room echo", burstIn, burstOut, gapIn,
              gapOut, lag * 1000.0 / sr);
  CHECK(finite, "dereverb output contains NaN or infinity");
  CHECK(gapOut < gapIn - 3.0f, "reverb tails only dropped by %.1f dB", gapIn - gapOut);
  CHECK(burstOut > burstIn - 2.5f, "dereverb dulled the direct sound by %.1f dB", burstIn - burstOut);

  // Strength 0 must be transparent (apart from the delay).
  std::vector<float> same = wet;
  aura::Dereverb off;
  off.prepare(float(sr));
  for (size_t at = 0; at < same.size(); at += 480) off.process(same.data() + at, 480, 0.0f);
  double err = 0, ref = 0;
  for (size_t i = size_t(sr); i + size_t(lag) < wet.size(); i++) {
    err += double(same[i + size_t(lag)] - wet[i]) * (same[i + size_t(lag)] - wet[i]);
    ref += double(wet[i]) * wet[i];
  }
  CHECK(err < ref * 1e-4, "dereverb at strength 0 is not transparent (error %.1f dB)", 10.0 * std::log10(err / ref + 1e-12));
}

#ifdef AURA_HAVE_DFN
// Same hiss as for RNNoise, through DeepFilterNet: it must be far cleaner and still fit a 10 ms callback.
static void runDeep(const char* model) {
  std::vector<float> x(size_t(48000) * 9);
  const std::vector<float> one = voice(48000);
  unsigned seed = 777;
  for (size_t i = 0; i < x.size(); i++) {
    seed = seed * 1664525u + 1013904223u;
    x[i] = one[i % one.size()] + (float(seed >> 8) / 8388608.0f - 1.0f) * 0.015f;
  }
  const std::vector<float> in = x;
  aura::DeepDenoiser d;
  CHECK(d.load(model, 48000), "DeepFilterNet did not load");
  double worst = 0;
  for (size_t at = 0; at + 480 <= x.size(); at += 480) {
    const auto t0 = std::chrono::steady_clock::now();
    d.process(x.data() + at, 480, 1.0f);
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    if (at > 48000) worst = std::max(worst, ms);
  }
  bool finite = true;
  for (float s : x) finite = finite && std::isfinite(s);
  const size_t base = size_t(6) * 48000, lag = 480 * 3;
  const float speechIn = rmsDb(in, base + 33600, base + 91200), speechOut = rmsDb(x, base + 33600 + lag, base + 91200 + lag);
  const float quietIn = rmsDb(in, base + 120000, base + 144000 - lag), quietOut = rmsDb(x, base + 120000 + lag, base + 144000);
  std::printf("%-22s sr=48000  speech %6.1f -> %6.1f dB | pause %6.1f -> %6.1f dB | worst frame %.2f ms of 10\n", "DeepFilterNet", speechIn,
              speechOut, quietIn, quietOut, worst);
  CHECK(finite, "DeepFilterNet output contains NaN or infinity");
  CHECK(quietOut < quietIn - 25.0f, "DeepFilterNet only removed %.1f dB of noise", quietIn - quietOut);
  CHECK(speechOut > speechIn - 6.0f, "DeepFilterNet ate the voice (%.1f dB)", speechOut - speechIn);
  CHECK(worst < 5.0, "DeepFilterNet needs %.1f ms for a 10 ms frame", worst);
}
#endif

// The point of the aligned shifter: a steady voice must stay steady. Measure how much the loudness
// wobbles (10 ms windows) with the taps aligned and with the plain two-tap shifter.
static float wobble(bool aligned, float semitones, float f0) {
  aura::PitchShifter shifter;
  shifter.prepare(48000);
  shifter.setAligned(aligned);
  const float ratio = std::pow(2.0f, semitones / 12.0f);
  std::vector<float> rms;
  double sum = 0;
  for (int i = 0; i < 48000 * 3; i++) {
    const float t = float(i) / 48000.0f;
    float x = 0;
    for (int k = 1; k <= 12; k++) x += std::sin(2 * aura::kPi * f0 * k * t) / float(k);
    const float y = shifter.process(x * 0.1f, ratio);
    if (i >= 24000) {
      sum += double(y) * y;
      if (i % 480 == 479) {
        rms.push_back(float(std::sqrt(sum / 480)));
        sum = 0;
      }
    }
  }
  double mean = 0, var = 0;
  for (float r : rms) mean += r;
  mean /= double(rms.size());
  for (float r : rms) var += (r - mean) * (r - mean);
  return float(std::sqrt(var / double(rms.size())) / mean);
}

static void runPitchQuality() {
  double plain = 0, aligned = 0;
  for (float f0 : {105.0f, 140.0f, 210.0f}) {
    for (float st : {-7.0f, -4.0f, 4.0f, 7.0f}) {
      const float p = wobble(false, st, f0), a = wobble(true, st, f0);
      plain += p;
      aligned += a;
      std::printf("pitch wobble  f0=%3.0f Hz %+3.0f st : plain %5.1f%%  aligned %5.1f%%\n", f0, st, p * 100, a * 100);
    }
  }
  std::printf("pitch wobble  average: plain %.1f%%  aligned %.1f%%\n", plain / 12 * 100, aligned / 12 * 100);
  CHECK(aligned < plain * 0.8, "aligning the taps should cut the loudness wobble (%.3f vs %.3f)", aligned / 12, plain / 12);
}

// The natural shifter's promise, measured: the pitch moves by the ratio asked for, while the
// vowel's resonance stays where it was. A buzz at `f0` is passed through a resonance at 900 Hz
// (a stand-in for a vowel formant), shifted, and then we look at what came out.
static std::vector<float> vowel(float f0, float formantHz, int seconds) {
  std::vector<float> x(size_t(48000) * seconds);
  const float r = 0.985f, w = 2 * aura::kPi * formantHz / 48000.0f;
  const float a1 = -2 * r * std::cos(w), a2 = r * r;
  float y1 = 0, y2 = 0;
  double phase = 0;
  for (size_t i = 0; i < x.size(); i++) {
    phase += f0 / 48000.0;
    float pulse = 0;
    if (phase >= 1.0) { phase -= 1.0; pulse = 1.0f; } // one glottal pulse per period
    const float y = pulse - a1 * y1 - a2 * y2;
    y2 = y1;
    y1 = y;
    x[i] = y * 0.02f;
  }
  return x;
}
static float pitchOf(const std::vector<float>& x, size_t from) {
  double best = -1;
  int bestLag = 0;
  for (int lag = 100; lag <= 700; lag++) {
    double c = 0;
    for (size_t i = from; i < from + 9600; i++) c += double(x[i]) * x[i + size_t(lag)];
    if (c > best * 1.02) { best = c; bestLag = lag; } // prefer the shorter of near-equal peaks
  }
  return 48000.0f / float(bestLag);
}
// Where the energy between 400 and 2200 Hz sits on average. A single band maximum would snap to
// whichever harmonic happens to be nearest; the centre of gravity moves smoothly with the resonance.
static float resonanceOf(const std::vector<float>& x, size_t from) {
  double weighted = 0, total = 0;
  for (float hz = 400; hz <= 2200; hz += 10) {
    double re = 0, im = 0;
    for (size_t i = 0; i < 9600; i++) {
      const double a = 2.0 * 3.14159265358979 * hz * double(i) / 48000.0;
      re += x[from + i] * std::cos(a);
      im += x[from + i] * std::sin(a);
    }
    const double power = re * re + im * im;
    weighted += power * hz;
    total += power;
  }
  return float(weighted / (total + 1e-30));
}
static void runNatural() {
  struct Case { float f0, semitones, formant; };
  for (const Case c : {Case{120, 5, 0}, Case{120, -4, 0}, Case{200, 4, 0}, Case{200, -5, 0}, Case{120, 0, 3}, Case{150, 6, 1.5f}}) {
    const std::vector<float> in = vowel(c.f0, 900, 3);
    const float ratio = std::pow(2.0f, c.semitones / 12.0f), formant = std::pow(2.0f, c.formant / 12.0f);
    aura::NaturalShifter natural;
    natural.prepare(48000);
    aura::PitchShifter plain;
    plain.prepare(48000);
    std::vector<float> a(in.size()), b(in.size());
    bool finite = true;
    float peak = 0;
    for (size_t i = 0; i < in.size(); i++) {
      a[i] = natural.process(in[i], ratio, formant);
      b[i] = plain.process(in[i], ratio);
      finite = finite && std::isfinite(a[i]);
      peak = std::max(peak, std::fabs(a[i]));
    }
    const size_t from = 48000;
    const float inPeak = *std::max_element(in.begin(), in.end());
    const float gotPitch = pitchOf(a, from), wantPitch = c.f0 * ratio;
    const float inRes = resonanceOf(in, from);
    const float gotRes = resonanceOf(a, from), wantRes = inRes * formant, plainRes = resonanceOf(b, from);
    std::printf("natural f0=%3.0f %+2.0f st, timbre %+4.1f st: pitch %5.1f Hz (want %5.1f) | resonance %4.0f Hz (want %4.0f; plain shifter moves it to %4.0f) | level x%.2f\n",
                c.f0, c.semitones, c.formant, gotPitch, wantPitch, gotRes, wantRes, plainRes, peak / inPeak);
    CHECK(finite, "natural shifter produced NaN or infinity");
    CHECK(std::fabs(gotPitch / wantPitch - 1) < 0.06f, "natural shifter: pitch %.1f Hz instead of %.1f", gotPitch, wantPitch);
    CHECK(std::fabs(gotRes / wantRes - 1) < 0.08f, "natural shifter: resonance moved to %.0f Hz, should be near %.0f", gotRes, wantRes);
    CHECK(peak / inPeak > 0.4f && peak / inPeak < 2.5f, "natural shifter changed the level by x%.2f", peak / inPeak);
  }
  aura::NaturalShifter lat;
  lat.prepare(48000);
  std::printf("latency: natural shifter                   %5.1f ms\n", lat.latency() * 1000.0 / 48000.0);
}

// Every ready voice must stay finite, inside full scale and audible; the cave must actually echo.
static void runEffects() {
  struct Voice { const char* name; aura::Params p; };
  aura::Params base;
  auto with = [&](void (*edit)(aura::Params&)) { aura::Params p = base; edit(p); return p; };
  const Voice voices[] = {
    {"robot", with([](aura::Params& p) { p.fxRingHz = 55; p.fxRingMix = 0.85f; })},
    {"alien", with([](aura::Params& p) { p.fxRingHz = 190; p.fxRingMix = 0.6f; p.fxPitch = 3; })},
    {"helium", with([](aura::Params& p) { p.fxPitch = 7; })},
    {"demon", with([](aura::Params& p) { p.fxPitch = -7; p.fxDrive = 0.3f; p.fxSpace = 0.5f; })},
    {"walkie-talkie", with([](aura::Params& p) { p.fxPhone = 1; p.fxDrive = 0.55f; })},
    {"megaphone", with([](aura::Params& p) { p.fxPhone = 1; p.fxDrive = 0.8f; p.fxEchoMs = 90; p.fxEchoFb = 0.2f; p.fxEchoMix = 0.25f; })},
    {"cave", with([](aura::Params& p) { p.fxEchoMs = 260; p.fxEchoFb = 0.5f; p.fxEchoMix = 0.45f; p.fxSpace = 0.8f; })},
    {"underwater", with([](aura::Params& p) { p.fxLowpassHz = 600; p.fxTremHz = 5; p.fxTremDepth = 0.5f; })},
    {"another person", with([](aura::Params& p) { p.fxPitch = 5; p.fxNatural = 1; p.fxFormant = 1.5f; })},
    {"everything", with([](aura::Params& p) { p.fxNatural = 1; p.fxFormant = 5; p.fxPitch = -12; p.fxRingHz = 2000; p.fxRingMix = 1; p.fxEchoMs = 600; p.fxEchoFb = 0.85f; p.fxEchoMix = 1; p.fxPhone = 1; p.fxDrive = 1; p.fxTremHz = 30; p.fxTremDepth = 1; p.fxLowpassHz = 8000; p.fxSpace = 1; })},
  };
  const std::vector<float> in = voice(48000);
  auto render = [&](const aura::Params& p, std::vector<float>& l) {
    std::vector<float> r(in.size());
    l.assign(in.size(), 0.0f);
    aura::Chain chain;
    chain.prepare(48000);
    chain.setParams(p);
    for (size_t at = 0; at < in.size(); at += 480) chain.process(in.data() + at, l.data() + at, r.data() + at, int(std::min<size_t>(480, in.size() - at)));
  };
  std::vector<float> plain, out;
  render(base, plain);
  const size_t a = size_t(0.7f * 48000), b = size_t(1.9f * 48000), tailFrom = size_t(2.25f * 48000), tailTo = size_t(2.6f * 48000);
  for (const Voice& v : voices) {
    render(v.p, out);
    float peak = 0;
    bool finite = true;
    for (float s : out) {
      finite = finite && std::isfinite(s);
      peak = std::max(peak, std::fabs(s));
    }
    const float speech = rmsDb(out, a, b), tail = rmsDb(out, tailFrom, tailTo);
    std::printf("voice %-14s speech %6.1f dB | 0.3 s after the phrase %6.1f dB | peak %.3f\n", v.name, speech, tail, peak);
    CHECK(finite, "%s: output contains NaN or infinity", v.name);
    CHECK(peak <= 1.0f, "%s: peak %.3f exceeds full scale", v.name, peak);
    CHECK(speech > -45.0f && speech < -3.0f, "%s: voice level %.1f dB is not usable", v.name, speech);
    if (std::string(v.name) == "cave") CHECK(tail > rmsDb(plain, tailFrom, tailTo) + 10.0f, "cave: no audible echo after the phrase");
  }
  const aura::Settings s = aura::parseSettings("fxpitch=-40\nfxring=55\nfxringmix=85\nfxecho=9999\nfxechofb=200\nfxphone=1\nfxdrive=30\nfxspace=50\n");
  CHECK(s.params.fxPitch == -12 && s.params.fxRingHz == 55 && std::fabs(s.params.fxRingMix - 0.85f) < 1e-5f && s.params.fxEchoMs == 600 &&
            std::fabs(s.params.fxEchoFb - 0.85f) < 1e-5f && s.params.fxPhone == 1 && std::fabs(s.params.fxDrive - 0.3f) < 1e-5f,
        "effect settings were not parsed or clamped");
}

// How late does each stage deliver? Measured, not assumed: a voice-like glide (its pitch keeps
// moving, so the match is unambiguous) goes in, and the output is slid against it until it fits.
static int lagOf(const std::vector<float>& in, const std::vector<float>& out, int maxLag) {
  int best = 0;
  double bestScore = -1e30;
  for (int lag = 0; lag <= maxLag; lag++) {
    double score = 0;
    for (size_t i = 30000; i < 90000; i += 2) score += double(in[i]) * out[i + size_t(lag)];
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  return best;
}

static void runLatency(const char* model) {
  const int sr = 48000;
  std::vector<float> x(size_t(sr) * 3, 0.0f);
  double phase = 0;
  for (size_t i = 0; i < x.size(); i++) {
    const float t = float(i) / sr;
    phase += 2.0 * 3.14159265358979 * (120.0 + 40.0 * t) / sr; // 120 → 240 Hz
    if (t > 0.4f && t < 2.2f) {
      for (int k = 1; k <= 15; k++) x[i] += 0.05f * float(std::sin(phase * k)) / float(k);
      x[i] *= 0.6f + 0.4f * std::sin(2 * aura::kPi * 3.0f * t);
    }
  }
  auto chunks = [&](std::vector<float>& y, int size, auto&& fn) {
    for (size_t at = 0; at + size_t(size) <= y.size(); at += size_t(size)) fn(y.data() + at, size);
  };
  auto report = [&](const char* name, const std::vector<float>& y) {
    const int lag = lagOf(x, y, 3000);
    std::printf("latency: %-34s %5.1f ms\n", name, lag * 1000.0 / sr);
    return lag;
  };

  std::vector<float> y = x;
  aura::Denoiser direct;
  direct.prepare(float(sr));
  chunks(y, 480, [&](float* p, int n) { direct.process(p, n, 1.0f, 1.0f); });
  const int fast = report("RNNoise, 10 ms buffers (normal)", y);

  y = x;
  aura::Denoiser buffered;
  buffered.prepare(float(sr));
  chunks(y, 441, [&](float* p, int n) { buffered.process(p, n, 1.0f, 1.0f); });
  const int slow = report("RNNoise, odd-sized buffers", y);

  y = x;
  aura::Dereverb echo;
  echo.prepare(float(sr));
  chunks(y, 480, [&](float* p, int n) { echo.process(p, n, 1.0f); });
  const int room = report("room echo", y);

  y = x;
  aura::PitchShifter shifter;
  shifter.prepare(float(sr));
  for (float& s : y) s = shifter.process(s, 1.0f); // ratio 1 keeps the taps still: the shortest it can be
  report("pitch shifter (at rest)", y);

  y = x;
  aura::Chain chain;
  chain.prepare(float(sr));
  std::vector<float> right(y.size());
  chunks(y, 480, [&](float* p, int n) { chain.process(p, p, right.data(), n); });
  const int core = report("voice chain itself", y);

  CHECK(fast <= 480, "RNNoise is %d samples late on 10 ms buffers; it should add no buffering", fast);
  CHECK(slow > fast, "the buffered path should be the slower one (%d vs %d samples)", slow, fast);
  CHECK(room <= 300, "room echo is %d samples late", room);
  CHECK(core <= 8, "the voice chain itself must be instant, measured %d samples", core);
#ifdef AURA_HAVE_DFN
  if (model) {
    y = x;
    aura::DeepDenoiser deep;
    deep.load(model, float(sr));
    chunks(y, 480, [&](float* p, int n) { deep.process(p, n, 1.0f); });
    const int lag = report("DeepFilterNet, 10 ms buffers", y);
    CHECK(lag <= 1500, "DeepFilterNet is %d samples late", lag);
  }
#else
  (void)model;
#endif
}

int main(int argc, char** argv) {
  runLatency(argc > 1 ? argv[1] : nullptr);
  runPitchQuality();
  runNatural();
  runEffects();
  (void)argc;
  (void)argv;
#ifdef AURA_HAVE_DFN
  if (argc > 1) runDeep(argv[1]);
  else CHECK(false, "pass the DeepFilterNet model path as the first argument");
#endif
  runDenoiser();
  runPitch();
  runDereverb();
  aura::Params def;
  aura::Params zero = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
  aura::Params max = {1, 1, 1, 1, 1, 1, 1, 1, 1, 12, 0};
  for (float sr : {48000.0f, 44100.0f, 16000.0f, 96000.0f}) {
    run("default", sr, def, true);
    run("everything off", sr, zero, false);
    run("everything at maximum", sr, max, false);
  }

  const aura::Settings s = aura::parseSettings("enabled=0\r\nnsengine=1\r\nplayid=7\r\nplaystop=-5\r\nclipgain=400\r\nwarmth=80\r\nfoo=1\r\nair=abc\r\ningain=99\r\n=5\r\nwidth=-3\r\nns=70\r\nmute=1\r\npop=250\r\npitch=-30\r\ndereverb=40\r\n");
  CHECK(s.params.pitch == -12.0f && std::fabs(s.dereverb - 0.4f) < 1e-5f, "pitch/dereverb were not parsed");
  CHECK(std::fabs(s.nsStrength - 0.7f) < 1e-5f && s.mute && s.params.pop == 1.0f, "ns/mute/pop were not parsed");
  CHECK(!s.enabled, "enabled=0 was not parsed");
  CHECK(s.nsEngine == 1, "nsengine was not parsed");
  CHECK(s.playId == 7 && s.playStop == 0 && s.clipGain == 1.5f, "soundboard keys were not parsed");
  CHECK(std::fabs(s.params.warmth - 0.8f) < 1e-5f, "warmth=%f", s.params.warmth);
  CHECK(std::fabs(s.params.air - aura::Params().air) < 1e-5f, "garbage changed air to %f", s.params.air);
  CHECK(s.params.inGainDb == 24.0f, "ingain was not clamped: %f", s.params.inGainDb);
  CHECK(s.params.width == 0.0f, "width was not clamped: %f", s.params.width);

  std::printf(failures ? "\n%d check(s) FAILED\n" : "\nall checks passed\n", failures);
  return failures ? 1 : 0;
}
