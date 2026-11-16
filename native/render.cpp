// AuraRender — runs a recording through exactly what the module does to the live microphone.
//
//   AuraRender <in.f32> <out.f32> <settings.txt> [DeepFilterNet model]
//
// in:  mono float32, 48 kHz.   out: stereo float32 (interleaved), 48 kHz, same length, in sync.
// Being off line it can do one thing the live path cannot: hear the recording once before
// rendering it, so levels are already settled on the first word.
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "aura_shared.h"
#include "aura_denoise.h"
#include "aura_dereverb.h"
#ifdef AURA_HAVE_DFN
#include "aura_dfn.h"
#endif

static bool readAll(const char* path, std::vector<char>& out) {
  FILE* f = std::fopen(path, "rb");
  if (!f) return false;
  std::fseek(f, 0, SEEK_END);
  const long size = std::ftell(f);
  std::fseek(f, 0, SEEK_SET);
  out.resize(size > 0 ? size_t(size) : 0);
  const size_t got = out.empty() ? 0 : std::fread(out.data(), 1, out.size(), f);
  std::fclose(f);
  return got == out.size();
}

int main(int argc, char** argv) {
  if (argc < 4) { std::fprintf(stderr, "usage: AuraRender in.f32 out.f32 settings.txt [model]\n"); return 2; }
  std::vector<char> raw, text;
  if (!readAll(argv[1], raw) || raw.size() < sizeof(float)) { std::fprintf(stderr, "cannot read input\n"); return 3; }
  if (!readAll(argv[3], text)) { std::fprintf(stderr, "cannot read settings\n"); return 3; }
  text.push_back(0);
  const aura::Settings s = aura::parseSettings(text.data());
  const size_t frames = raw.size() / sizeof(float);
  std::vector<float> in(frames);
  std::memcpy(in.data(), raw.data(), frames * sizeof(float));

  const float sr = 48000.0f;
  aura::Denoiser fast;
  fast.prepare(sr);
  aura::Dereverb echo;
  echo.prepare(sr);
  aura::Chain chain;
  chain.prepare(sr);
  chain.setParams(s.params);
  bool deep = false;
#ifdef AURA_HAVE_DFN
  aura::DeepDenoiser dfn;
  if (s.nsEngine == 1 && argc > 4) deep = dfn.load(argv[4], sr);
#endif

  int latency = chain.latency();
  if (s.nsStrength > 0.005f) latency += deep ? 1440 : 480;
  if (s.dereverb > 0.005f) latency += echo.latencySamples();

  const int block = 480;
  std::vector<float> mono(block), l(block), r(block);
  auto run = [&](const float* src, size_t count, std::vector<float>* out) {
    for (size_t at = 0; at < count; at += block) {
      const size_t n = count - at < size_t(block) ? count - at : size_t(block);
      for (size_t i = 0; i < size_t(block); i++) mono[i] = i < n && src ? src[at + i] : 0.0f;
      if (s.nsStrength > 0.005f) {
#ifdef AURA_HAVE_DFN
        if (deep) dfn.process(mono.data(), block, s.nsStrength);
        else
#endif
        if (fast.ready()) fast.process(mono.data(), block, aura::denoiseAmount(s.nsStrength), aura::denoiseGateFloor(s.nsStrength));
      }
      if (s.dereverb > 0.005f) echo.process(mono.data(), block, s.dereverb);
      chain.process(mono.data(), l.data(), r.data(), block);
      if (out) for (int i = 0; i < block; i++) { out->push_back(l[size_t(i)]); out->push_back(r[size_t(i)]); }
    }
  };
  // First hearing: up to 12 s, so auto-level, loudness and pitch tracking have settled; then a
  // second of silence so no echo of it leaks into the real pass.
  run(in.data(), frames < size_t(12 * 48000) ? frames : size_t(12 * 48000), nullptr);
  run(nullptr, 48000, nullptr);

  std::vector<float> out;
  out.reserve((frames + size_t(latency) + size_t(block)) * 2);
  run(in.data(), frames, &out);
  run(nullptr, size_t(latency) + size_t(block), &out); // flush what the look-ahead stages still hold

  FILE* f = std::fopen(argv[2], "wb");
  if (!f) { std::fprintf(stderr, "cannot write output\n"); return 4; }
  const size_t wrote = std::fwrite(out.data() + size_t(latency) * 2, sizeof(float), frames * 2, f);
  std::fclose(f);
  if (wrote != frames * 2) { std::fprintf(stderr, "short write\n"); return 4; }
  std::printf("ok frames=%zu latency=%d engine=%s\n", frames, latency, s.nsStrength > 0.005f ? (deep ? "deep" : "fast") : "none");
  return 0;
}
