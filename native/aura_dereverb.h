// Room-echo reduction without a neural network.
//
// Late reverberation is, roughly, an exponentially decaying copy of what was said ~50 ms ago.
// So for every frequency band we predict the reverb power from the band's own past, and turn
// the band down by however much of its current power that prediction explains (spectral
// subtraction, after Lebart / Habets). Direct speech is louder than its own tail and passes.
//
// Short-time Fourier transform, 75 % overlap; adds one frame of latency (10.7 ms at 48 kHz).
#pragma once

#include <algorithm>
#include <cmath>
#include <vector>

namespace aura {

// In-place radix-2 FFT; n must be a power of two.
inline void fft(float* re, float* im, int n, bool inverse) {
  for (int i = 1, j = 0; i < n; i++) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      std::swap(re[i], re[j]);
      std::swap(im[i], im[j]);
    }
  }
  for (int len = 2; len <= n; len <<= 1) {
    const double angle = 2.0 * 3.14159265358979323846 / len * (inverse ? 1.0 : -1.0);
    const float wr = float(std::cos(angle)), wi = float(std::sin(angle));
    for (int i = 0; i < n; i += len) {
      float cr = 1, ci = 0;
      for (int k = 0; k < len / 2; k++) {
        const int a = i + k, b = a + len / 2;
        const float xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const float t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) {
    const float scale = 1.0f / float(n);
    for (int i = 0; i < n; i++) {
      re[i] *= scale;
      im[i] *= scale;
    }
  }
}

class Dereverb {
 public:
  // Allocates; call outside the audio thread.
  void prepare(float sr) {
    n_ = sr > 50000 ? 1024 : 512;
    hop_ = n_ / 4;
    bins_ = n_ / 2 + 1;
    window_.resize(size_t(n_));
    for (int i = 0; i < n_; i++) window_[size_t(i)] = std::sqrt(0.5f - 0.5f * std::cos(2.0f * 3.14159265f * float(i) / float(n_)));
    in_.assign(size_t(n_), 0.0f);
    ola_.assign(size_t(n_), 0.0f);
    out_.assign(size_t(hop_), 0.0f);
    re_.assign(size_t(n_), 0.0f);
    im_.assign(size_t(n_), 0.0f);
    smooth_.assign(size_t(bins_), 0.0f);
    gain_.assign(size_t(bins_), 1.0f);

    const float delay = 0.05f;  // reverb that arrives later than this is "late"
    const float t60 = 0.5f;     // assumed room: a typical untreated bedroom or office
    delayFrames_ = std::max(2, int(delay * sr / float(hop_) + 0.5f));
    history_.assign(size_t(delayFrames_ * bins_), 0.0f);
    decay_ = std::exp(-2.0f * (3.0f * std::log(10.0f) / t60) * delay);
    historyPos_ = 0;
    pos_ = 0;
  }

  int latencySamples() const { return n_; }

  // In place; strength 0..1.
  void process(float* x, int frames, float strength) {
    for (int i = 0; i < frames; i++) {
      in_[size_t(n_ - hop_ + pos_)] = x[i];
      x[i] = out_[size_t(pos_)];
      if (++pos_ == hop_) {
        pos_ = 0;
        frame(strength);
      }
    }
  }

 private:
  void frame(float strength) {
    for (int i = 0; i < n_; i++) {
      re_[size_t(i)] = in_[size_t(i)] * window_[size_t(i)];
      im_[size_t(i)] = 0;
    }
    fft(re_.data(), im_.data(), n_, false);

    float* past = &history_[size_t(historyPos_ * bins_)]; // band powers from `delayFrames_` frames ago
    for (int k = 0; k < bins_; k++) {
      const float power = re_[size_t(k)] * re_[size_t(k)] + im_[size_t(k)] * im_[size_t(k)];
      smooth_[size_t(k)] += (power - smooth_[size_t(k)]) * 0.35f;
      const float late = decay_ * past[k];
      // Never cut a band by more than 12 dB: deeper than that starts to sound like a phone call.
      const float want = std::sqrt(std::max(1.0f - strength * 1.6f * late / (power + 1e-12f), 0.0625f));
      gain_[size_t(k)] += (want - gain_[size_t(k)]) * (want > gain_[size_t(k)] ? 0.7f : 0.4f);
      past[k] = smooth_[size_t(k)];

      const float g = gain_[size_t(k)];
      re_[size_t(k)] *= g;
      im_[size_t(k)] *= g;
      if (k > 0 && k < n_ / 2) { // mirror bin
        re_[size_t(n_ - k)] *= g;
        im_[size_t(n_ - k)] *= g;
      }
    }
    historyPos_ = (historyPos_ + 1) % delayFrames_;

    fft(re_.data(), im_.data(), n_, true);
    for (int i = 0; i < n_; i++) ola_[size_t(i)] += re_[size_t(i)] * window_[size_t(i)] * 0.5f; // Hann² at 75 % overlap sums to 2

    for (int i = 0; i < hop_; i++) out_[size_t(i)] = ola_[size_t(i)];
    std::copy(ola_.begin() + hop_, ola_.end(), ola_.begin());
    std::fill(ola_.end() - hop_, ola_.end(), 0.0f);
    std::copy(in_.begin() + hop_, in_.end(), in_.begin());
  }

  int n_ = 512, hop_ = 128, bins_ = 257, delayFrames_ = 19, historyPos_ = 0, pos_ = 0;
  float decay_ = 0.25f;
  std::vector<float> window_, in_, ola_, out_, re_, im_, smooth_, gain_, history_;
};

} // namespace aura
