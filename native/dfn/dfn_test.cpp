// Experiment: can DeepFilterNet 3 run inside a 10 ms audio callback, and how much better is it?
// Usage: dfn_test <path to DeepFilterNet3_onnx.tar.gz>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <vector>

extern "C" {
struct DFState;
DFState* df_create(const char* path, float atten_lim);
size_t df_get_frame_length(DFState* st);
void df_set_atten_lim(DFState* st, float lim_db);
void df_set_post_filter_beta(DFState* st, float beta);
float df_process_frame(DFState* st, float* input, float* output);
void df_free(DFState* st);
}

static const float kPi = 3.14159265f;

static float rmsDb(const std::vector<float>& x, size_t from, size_t to) {
  double sum = 0;
  for (size_t i = from; i < to; i++) sum += double(x[i]) * x[i];
  return float(10.0 * std::log10(sum / double(to - from) + 1e-12));
}

int main(int argc, char** argv) {
  if (argc < 2) return 2;
  using clock = std::chrono::steady_clock;
  auto ms = [](clock::time_point a, clock::time_point b) { return std::chrono::duration<double, std::milli>(b - a).count(); };

  const auto t0 = clock::now();
  DFState* st = df_create(argv[1], 100.0f);
  const auto t1 = clock::now();
  if (!st) { std::printf("df_create failed\n"); return 1; }
  const size_t hop = df_get_frame_length(st);
  std::printf("model loaded in %.0f ms, frame = %zu samples\n", ms(t0, t1), hop);

  // 30 s: [0.5 s hiss | 1.5 s syllables in hiss | 1 s hiss] x 10, hiss at -41 dB RMS.
  const int sr = 48000;
  std::vector<float> in(size_t(sr) * 30);
  unsigned seed = 12345;
  for (size_t i = 0; i < in.size(); i++) {
    const float t = std::fmod(float(i) / sr, 3.0f);
    seed = seed * 1664525u + 1013904223u;
    float s = (float(seed >> 8) / 8388608.0f - 1.0f) * 0.015f;
    if (t >= 0.5f && t < 2.0f) {
      float saw = 0;
      for (int k = 1; k <= 20; k++) saw += std::sin(2 * kPi * 140.0f * k * t) / float(k);
      s += saw * 0.08f * (0.55f + 0.45f * std::sin(2 * kPi * 4.0f * t));
    }
    in[i] = s;
  }

  std::vector<float> out(in.size(), 0.0f);
  std::vector<double> times;
  for (size_t at = 0; at + hop <= in.size(); at += hop) {
    const auto a = clock::now();
    df_process_frame(st, in.data() + at, out.data() + at);
    times.push_back(ms(a, clock::now()));
  }
  df_free(st);

  // Skip the first 3 s (warm-up) for both quality and timing.
  bool finite = true;
  for (float s : out) finite = finite && std::isfinite(s);
  double speechIn = 0, speechOut = 0, quietIn = 0, quietOut = 0;
  int cycles = 0;
  for (int c = 1; c < 9; c++, cycles++) {
    const size_t base = size_t(c) * 3 * sr, lag = 2 * hop; // the model looks ~2 frames ahead
    speechIn += rmsDb(in, base + size_t(0.7f * sr), base + size_t(1.9f * sr));
    speechOut += rmsDb(out, base + size_t(0.7f * sr) + lag, base + size_t(1.9f * sr) + lag);
    quietIn += rmsDb(in, base + size_t(2.5f * sr), base + size_t(3.0f * sr));
    quietOut += rmsDb(out, base + size_t(2.5f * sr) + lag, base + size_t(3.0f * sr) + lag);
  }
  std::vector<double> steady(times.begin() + 300, times.end());
  std::sort(steady.begin(), steady.end());
  double sum = 0;
  for (double t : steady) sum += t;
  const double frameMs = double(hop) * 1000.0 / sr;
  std::printf("quality : speech %.1f -> %.1f dB | pause %.1f -> %.1f dB | finite=%d\n", speechIn / cycles, speechOut / cycles,
              quietIn / cycles, quietOut / cycles, finite ? 1 : 0);
  std::printf("timing  : frame budget %.1f ms | mean %.2f ms | p99 %.2f ms | p99.9 %.2f ms | max %.2f ms | first frames max %.1f ms\n",
              frameMs, sum / steady.size(), steady[size_t(steady.size() * 0.99)], steady[size_t(steady.size() * 0.999)],
              steady.back(), *std::max_element(times.begin(), times.begin() + 300));
  std::printf("load    : %.1f%% of one core\n", sum / steady.size() / frameMs * 100.0);
  return finite ? 0 : 1;
}
