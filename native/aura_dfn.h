// "High quality" noise suppression: DeepFilterNet 3 (Hendrik Schröter, MIT / Apache-2.0),
// linked in as a static library built from its Rust sources.
//
// Much stronger than RNNoise, at the price of ~40 ms of latency (the network looks two frames
// ahead) and a few percent of one CPU core. 48 kHz mono, 10 ms frames.
#pragma once

#include <atomic>
#include <cstddef>

extern "C" {
struct DFState;
DFState* df_create(const char* path, float atten_lim);
size_t df_get_frame_length(DFState* st);
void df_set_atten_lim(DFState* st, float lim_db);
void df_set_post_filter_beta(DFState* st, float beta);
float df_process_frame(DFState* st, float* input, float* output);
void df_free(DFState* st);
}

namespace aura {

class DeepDenoiser {
 public:
  static constexpr int kFrame = 480;

  DeepDenoiser() = default;
  DeepDenoiser(const DeepDenoiser&) = delete;
  DeepDenoiser& operator=(const DeepDenoiser&) = delete;
  ~DeepDenoiser() {
    if (DFState* s = state_.exchange(nullptr)) df_free(s);
  }

  // Loads the model (~250 ms, allocates): never call from the audio thread.
  // `modelPath` is UTF-8 and must exist — the library aborts the process on a bad model.
  bool load(const char* modelPath, float sampleRate) {
    if (ready()) return true;
    if (sampleRate != 48000.0f) return false;
    DFState* s = df_create(modelPath, 100.0f);
    if (!s) return false;
    if (df_get_frame_length(s) != size_t(kFrame)) {
      df_free(s);
      return false;
    }
    float silence[kFrame] = {}, scratch[kFrame];
    for (int i = 0; i < 8; i++) df_process_frame(s, silence, scratch); // warm up caches and lazy buffers
    state_.store(s, std::memory_order_release);
    return true;
  }

  bool ready() const { return state_.load(std::memory_order_acquire) != nullptr; }

  // In place; strength 0..1 caps how far noise may be pushed down (6 dB … unlimited).
  void process(float* x, int frames, float strength) {
    DFState* s = state_.load(std::memory_order_acquire);
    if (!s) return;
    if (strength != lastStrength_) {
      lastStrength_ = strength;
      df_set_atten_lim(s, strength >= 0.995f ? 100.0f : 6.0f + strength * 54.0f);
      df_set_post_filter_beta(s, strength > 0.62f ? 0.02f : 0.0f);
    }
    for (int i = 0; i < frames; i++) {
      in_[fill_] = x[i];
      x[i] = out_[fill_];
      if (++fill_ == kFrame) {
        fill_ = 0;
        df_process_frame(s, in_, out_);
      }
    }
  }

 private:
  std::atomic<DFState*> state_{nullptr};
  float in_[kFrame] = {};
  float out_[kFrame] = {};
  int fill_ = 0;
  float lastStrength_ = -1;
};

} // namespace aura
