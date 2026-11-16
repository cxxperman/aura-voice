// Neural noise suppression (RNNoise, Xiph.Org, BSD-3-Clause).
//
// RNNoise works on 10 ms frames of 48 kHz mono, so this wrapper buffers the stream into
// frames and hands back the previous frame: a constant 10 ms of latency, in any block size.
#pragma once

extern "C" {
#include "rnnoise.h"
}

namespace aura {

class Denoiser {
 public:
  static constexpr int kFrame = 480;

  Denoiser() = default;
  Denoiser(const Denoiser&) = delete;
  Denoiser& operator=(const Denoiser&) = delete;
  ~Denoiser() { release(); }

  // Not real-time safe: allocates, and warms the library up so process() never has to.
  bool prepare(float sampleRate) {
    release();
    if (sampleRate != 48000.0f) return false; // the model only knows 48 kHz
    state_ = rnnoise_create(nullptr);
    if (!state_) return false;
    float silence[kFrame] = {}, scratch[kFrame];
    rnnoise_process_frame(state_, scratch, silence); // first call builds the FFT tables
    for (int i = 0; i < kFrame; i++) in_[i] = out_[i] = 0;
    fill_ = 0;
    return true;
  }

  bool ready() const { return state_ != nullptr; }

  // In place. `amount` 0..1 blends the cleaned signal with the (equally delayed) original.
  void process(float* x, int frames, float amount) {
    for (int i = 0; i < frames; i++) {
      in_[fill_] = x[i];
      x[i] = out_[fill_];
      if (++fill_ == kFrame) {
        fill_ = 0;
        float scaled[kFrame], clean[kFrame];
        for (int k = 0; k < kFrame; k++) scaled[k] = in_[k] * 32768.0f; // the model expects 16-bit scale
        rnnoise_process_frame(state_, clean, scaled);
        for (int k = 0; k < kFrame; k++) out_[k] = in_[k] + (clean[k] / 32768.0f - in_[k]) * amount;
      }
    }
  }

 private:
  void release() {
    if (state_) rnnoise_destroy(state_);
    state_ = nullptr;
  }

  DenoiseState* state_ = nullptr;
  float in_[kFrame] = {};
  float out_[kFrame] = {};
  int fill_ = 0;
};

} // namespace aura
