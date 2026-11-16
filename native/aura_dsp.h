// Aura voice chain — the C++ twin of app/engine.js.
//
// mono in → input gain → high-pass → dynamics (gate, auto-level, de-esser)
//         → EQ (mud cut, warmth, presence, air) → compressor → exciter
//         → stereo doubler + room reverb → limiter → stereo out
//
// Header-only, no dependencies. prepare() allocates; process() never does,
// so it is safe to call from the audio engine's real-time thread.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

namespace aura {

constexpr float kPi = 3.14159265358979f;

// Sliders are 0..1, gains are in dB.
struct Params {
  float warmth = 0.55f;
  float clarity = 0.50f;
  float air = 0.45f;
  float density = 0.55f;
  float width = 0.35f;
  float space = 0.12f;
  float clean = 0.45f;
  float deess = 0.50f;
  float autoLevel = 1.0f;
  float inGainDb = 0.0f;
  float outGainDb = 0.0f;
  float pop = 0.50f; // de-plosive: tames "p"/"b" blasts
  float pitch = 0.0f; // semitones, -12..+12; 0 = untouched
  float multiband = 0;    // 0..1 "broadcast": three-band compression — steady lows, tamed top
  float satLow = 0;       // 0..1 harmonics generated from the low end: the voice sounds fuller on small speakers
  float dehum = 0;        // 1 = notch out mains hum (50 Hz and its first harmonics)
  float loudTarget = 0;   // output loudness to hold, LUFS (e.g. -16); 0 = off
  float excite = -1.0f; // harmonics on top of the voice, 0..1; below zero = follow clarity and air (older windows)

  // Voice effects — the "ready voices" (robot, cave, walkie-talkie…). All neutral at zero.
  float fxPitch = 0;      // semitones, added to `pitch`
  float fxRingHz = 0;     // ring-modulator carrier in Hz; 0 = off
  float fxRingMix = 0;    // 0..1
  float fxEchoMs = 0;     // echo delay; 0 = off
  float fxEchoFb = 0;     // 0..0.85
  float fxEchoMix = 0;    // 0..1
  float fxPhone = 0;      // 1 = telephone band (420 Hz … 3.2 kHz)
  float fxDrive = 0;      // 0..1 distortion
  float fxTremHz = 0;     // tremolo rate; 0 = off
  float fxTremDepth = 0;  // 0..1
  float fxLowpassHz = 0;  // muffling low-pass; 0 = off
  float fxSpace = 0;      // extra room, added to `space`
  float fxNatural = 0;    // 1 = shift the pitch but keep the timbre (NaturalShifter), for "another person" voices
  float fxFormant = 0;    // semitones the timbre itself is moved by, natural mode only

  // Microphone profile: a corrective EQ for the capsule itself, ahead of everything else, so the
  // character presets start from a flat, clean microphone. The same bank carries the user's own
  // frequency equalizer (bass, body, presence, air…). Up to kMicBands parametric bands;
  // gain 0 = unused, Q 0 = a shelf (low below 1 kHz, high above).
  static constexpr int kMicBands = 14;
  float micHp = 85;       // high-pass corner, Hz
  float micF[kMicBands] = {};
  float micG[kMicBands] = {};
  float micQ[kMicBands] = {};
};

inline float dbToGain(float db) { return std::pow(10.0f, db / 20.0f); }
inline float dbToGainFast(float db) { return std::exp(db * 0.115129255f); }
inline float onePole(float seconds, float sr) { return 1.0f - std::exp(-1.0f / (seconds * sr)); }

// RBJ cookbook biquad, transposed direct form II.
struct Biquad {
  float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;

  inline float process(float x) {
    const float y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    return y;
  }
  void reset() { z1 = z2 = 0; }

  void set(float B0, float B1, float B2, float A0, float A1, float A2) {
    b0 = B0 / A0; b1 = B1 / A0; b2 = B2 / A0; a1 = A1 / A0; a2 = A2 / A0;
  }
  // Capture can run at 16 kHz; keep every corner safely below Nyquist.
  static float omega(float sr, float f) { return 2.0f * kPi * std::min(f, 0.45f * sr) / sr; }

  void highpass(float sr, float f, float q) {
    const float w = omega(sr, f), cs = std::cos(w), al = std::sin(w) / (2 * q);
    set((1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + al, -2 * cs, 1 - al);
  }
  void lowpass(float sr, float f, float q) {
    const float w = omega(sr, f), cs = std::cos(w), al = std::sin(w) / (2 * q);
    set((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al);
  }
  void peaking(float sr, float f, float q, float gainDb) {
    const float A = std::pow(10.0f, gainDb / 40.0f);
    const float w = omega(sr, f), cs = std::cos(w), al = std::sin(w) / (2 * q);
    set(1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A);
  }
  void lowshelf(float sr, float f, float gainDb) {
    const float A = std::pow(10.0f, gainDb / 40.0f);
    const float w = omega(sr, f), cs = std::cos(w);
    const float k = 2 * std::sqrt(A) * (std::sin(w) / 2 * std::sqrt(2.0f));
    set(A * ((A + 1) - (A - 1) * cs + k), 2 * A * ((A - 1) - (A + 1) * cs), A * ((A + 1) - (A - 1) * cs - k),
        (A + 1) + (A - 1) * cs + k, -2 * ((A - 1) + (A + 1) * cs), (A + 1) + (A - 1) * cs - k);
  }
  void notch(float sr, float f, float q) {
    const float w = omega(sr, f), cs = std::cos(w), al = std::sin(w) / (2 * q);
    set(1, -2 * cs, 1, 1 + al, -2 * cs, 1 - al);
  }
  void highshelf(float sr, float f, float gainDb) {
    const float A = std::pow(10.0f, gainDb / 40.0f);
    const float w = omega(sr, f), cs = std::cos(w);
    const float k = 2 * std::sqrt(A) * (std::sin(w) / 2 * std::sqrt(2.0f));
    set(A * ((A + 1) + (A - 1) * cs + k), -2 * A * ((A - 1) + (A + 1) * cs), A * ((A + 1) + (A - 1) * cs - k),
        (A + 1) - (A - 1) * cs + k, 2 * ((A - 1) - (A + 1) * cs), (A + 1) - (A - 1) * cs - k);
  }
};

// Gate + auto-level + de-esser, sample by sample.
struct Dynamics {
  float env = 0, g = 1, hold = 0;
  bool open = false;
  float rms = 0.01f, ag = 1;
  float lp = 0, envHi = 0, dg = 1;
  float lo = 0, envLo = 0, pg = 1;
  float envRel = 0, gAtt = 0, gRel = 0, holdN = 0, rmsA = 0, agA = 0, lpA = 0, hiRel = 0, loA = 0, loRel = 0;

  void prepare(float sr) {
    envRel = std::exp(-1.0f / (0.05f * sr));
    gAtt = onePole(0.002f, sr);
    gRel = onePole(0.12f, sr);
    holdN = 0.18f * sr;
    rmsA = onePole(0.4f, sr);
    agA = onePole(1.5f, sr);
    lpA = 1.0f - std::exp(-2.0f * kPi * std::min(5200.0f, 0.4f * sr) / sr);
    hiRel = std::exp(-1.0f / (0.03f * sr));
    loA = 1.0f - std::exp(-2.0f * kPi * 100.0f / sr);
    loRel = std::exp(-1.0f / (0.06f * sr));
  }

  inline float process(float x, float thr, float deess, bool autoLevel, float pop) {
    const float a = std::fabs(x);
    env = std::max(a, env * envRel);

    // Downward expander rather than a gate: a hard gate chops the quiet starts and ends of words
    // (f, s, h, trailing vowels) the moment they dip under the threshold. Here sound just under
    // the threshold is only a little quieter, and it takes 10 dB under to reach the -30 dB floor.
    // Opens fast, holds through the gaps between words.
    float tg = 1.0f;
    if (env >= thr) hold = holdN;
    else if (hold > 0) hold -= 1;
    else { const float r = env / thr; tg = std::max(0.03f, r * r * r); }
    open = tg > 0.5f;
    g += (tg - g) * (tg > g ? gAtt : gRel);

    // Auto-level: ride slowly towards -20 dBFS RMS, only while there is speech.
    if (autoLevel) {
      if (env > std::max(thr, 0.01f)) {
        rms += (x * x - rms) * rmsA;
        const float want = std::clamp(0.1f / (std::sqrt(rms) + 1e-6f), 0.5f, 6.0f);
        ag += (want - ag) * agA;
      }
    } else {
      ag += (1.0f - ag) * agA;
    }
    x *= g * ag;

    // De-plosive: the band under ~100 Hz sits below most voices' pitch, so a burst there is
    // breath hitting the capsule, not speech. Duck just that band while it lasts.
    lo += (x - lo) * loA;
    envLo = std::max(std::fabs(lo), envLo * loRel);
    const float popThr = 0.04f;
    const float tp = (pop > 0 && envLo > popThr) ? std::pow(popThr / envLo, pop * 0.9f) : 1.0f;
    pg += (tp - pg) * (tp < pg ? 0.05f : 0.004f);
    x = (x - lo) + lo * pg;

    // De-esser: split at ~5 kHz, duck only the top band when sibilance spikes.
    lp += (x - lp) * lpA;
    const float hi = x - lp;
    envHi = std::max(std::fabs(hi), envHi * hiRel);
    const float deThr = 0.02f;
    const float td = (deess > 0 && envHi > deThr) ? std::pow(deThr / envHi, deess * 0.75f) : 1.0f;
    dg += (td - dg) * 0.02f;
    return lp + hi * dg;
  }
};

// Pitch shifter: two taps sweep through a short delay line (which is what changes the pitch)
// and cross-fade into each other every time one of them has to jump back.
//
// The jump is where such shifters go wrong: if the tap lands at an arbitrary place, the two
// taps play the voice out of phase during the cross-fade and partly cancel — the familiar
// warble. So each time a tap jumps (it is silent at that instant), it is slid by up to a few
// milliseconds to the spot where the waveform best matches what the other tap is playing.
// Costs ~20-28 ms of latency while in use.
class PitchShifter {
 public:
  void prepare(float sr) {
    window_ = 0.040f * sr;
    search_ = int(0.008f * sr);
    span_ = int(0.014f * sr); // longer than one period of the lowest voices, or they cannot be matched
    size_ = 1;
    while (size_ < int(window_) + 2 * search_ + span_ + 16) size_ <<= 1;
    buf_.assign(size_t(size_), 0.0f);
    pos_ = 0;
    phase_ = 0;
    offset_[0] = offset_[1] = 0;
  }
  void setAligned(bool on) { aligned_ = on; } // off = the plain two-tap shifter, kept for comparison in tests

  inline float process(float x, float ratio) {
    buf_[size_t(pos_)] = x;
    const float before = phase_;
    phase_ += (1.0f - ratio) / window_; // the delay grows to lower the pitch, shrinks to raise it
    bool jumpA = false;
    if (phase_ >= 1.0f) { phase_ -= 1.0f; jumpA = true; }
    if (phase_ < 0.0f) { phase_ += 1.0f; jumpA = true; }
    const float other = phase_ >= 0.5f ? phase_ - 0.5f : phase_ + 0.5f;
    const float otherBefore = before >= 0.5f ? before - 0.5f : before + 0.5f;
    const bool jumpB = std::fabs(other - otherBefore) > 0.5f;
    if (aligned_) {
      if (jumpA) offset_[0] = align(phase_, other, offset_[1]);
      if (jumpB) offset_[1] = align(other, phase_, offset_[0]);
    }
    const float w = 0.5f - 0.5f * std::cos(2.0f * kPi * phase_); // silent exactly where the tap jumps
    const float out = tap(2.0f + phase_ * window_ + offset_[0]) * w + tap(2.0f + other * window_ + offset_[1]) * (1.0f - w);
    pos_ = (pos_ + 1) & (size_ - 1);
    return out;
  }

 private:
  // Where should the tap that just jumped land so that it is in phase with the other one?
  float align(float jumped, float playing, float playingOffset) const {
    const int ref = int(2.0f + playing * window_ + playingOffset);
    const int nominal = int(2.0f + jumped * window_);
    const bool nearZero = jumped < 0.5f; // at the short end of the delay it can only move further back
    const int from = nearZero ? 0 : -2 * search_, to = nearZero ? 2 * search_ : 0;
    float best = -1e30f;
    int bestOffset = 0;
    for (int o = from; o <= to; o += 2) {
      float dot = 0, energy = 1e-9f;
      for (int k = 0; k < span_; k += 2) {
        const float c = at(nominal + o + k);
        dot += c * at(ref + k);
        energy += c * c;
      }
      const float score = dot / std::sqrt(energy);
      if (score > best) {
        best = score;
        bestOffset = o;
      }
    }
    return float(bestOffset);
  }
  inline float at(int delay) const { return buf_[size_t((pos_ - delay) & (size_ - 1))]; }
  inline float tap(float delay) const {
    float where = float(pos_) - delay;
    if (where < 0) where += float(size_);
    const int i0 = int(where);
    const float frac = where - float(i0);
    return buf_[size_t(i0 & (size_ - 1))] * (1 - frac) + buf_[size_t((i0 + 1) & (size_ - 1))] * frac;
  }
  std::vector<float> buf_;
  int size_ = 1, pos_ = 0, search_ = 384, span_ = 384;
  float window_ = 1920, phase_ = 0;
  float offset_[2] = {0, 0};
  bool aligned_ = true;
};

// Natural pitch shifter (pitch-synchronous overlap-add).
//
// The plain shifter above resamples the voice, so the pitch and the timbre move together — up
// gives a chipmunk, down a giant. A different *person* needs the pitch to move while the mouth
// and throat (the formants) stay roughly where they are. So this one cuts the voice into
// grains two pitch periods long and lays them out again at a different spacing: the spacing
// sets the new pitch, the grains themselves keep the timbre. Reading each grain a little
// faster or slower moves the timbre on its own, by a small amount.
//
// It needs to know the pitch period, so it measures it ~190 times a second, and it has to
// hold nearly three periods of audio before it can speak: about 36 ms of latency.
class NaturalShifter {
 public:
  void prepare(float sr) {
    minPeriod_ = int(sr / 400.0f);
    maxPeriod_ = int(sr / 80.0f);
    latency_ = int(float(maxPeriod_) * 2.9f) + 8;
    size_ = 1;
    while (size_ < latency_ * 4) size_ <<= 1;
    in_.assign(size_t(size_), 0.0f);
    out_.assign(size_t(size_), 0.0f);
    score_.assign(size_t(maxPeriod_ / 2 + 2), 0.0f);
    n_ = 0;
    period_ = sr / 150.0f;
    synth_ = source_ = 0;
  }
  int latency() const { return latency_; }
  float period() const { return period_; }

  inline float process(float x, float pitchRatio, float formantRatio) {
    in_[size_t(n_ & (size_ - 1))] = x;
    if ((n_ & 255) == 255) measure();
    // Lay down every grain whose source audio has fully arrived.
    while (synth_ + double(period_) * (0.5 + formantRatio) + 2.0 <= double(n_)) grain(pitchRatio, formantRatio);
    const int64_t m = n_ - latency_;
    float y = 0;
    if (m >= 0) {
      y = out_[size_t(m & (size_ - 1))];
      out_[size_t(m & (size_ - 1))] = 0;
    }
    n_++;
    return y;
  }

 private:
  void grain(float pitchRatio, float formantRatio) {
    const double P = period_;
    // Take the grain a whole number of periods after the previous one, as close to "now" as that
    // allows: repeating a period raises the pitch, skipping one lowers it, and the phase stays intact.
    const double k = std::max(0.0, std::floor((synth_ - source_) / P + 0.5));
    source_ += k * P;
    const int half = int(P);
    const float gain = 1.0f / std::max(pitchRatio, 0.5f); // grains overlap pitchRatio-fold
    const int64_t centre = int64_t(synth_ + 0.5);
    for (int i = -half; i <= half; i++) {
      const int64_t at = centre + i;
      if (at <= n_ - latency_) continue; // already played: never write into the past
      const float w = 0.5f + 0.5f * std::cos(kPi * float(i) / float(half));
      out_[size_t(at & (size_ - 1))] += sample(source_ + double(i) * formantRatio) * w * gain;
    }
    synth_ += P / std::max(pitchRatio, 0.5f);
  }
  inline float sample(double where) const {
    if (where < 0 || where > double(n_ - 1)) return 0;
    const int64_t i0 = int64_t(where);
    const float frac = float(where - double(i0));
    return in_[size_t(i0 & (size_ - 1))] * (1 - frac) + in_[size_t((i0 + 1) & (size_ - 1))] * frac;
  }
  inline float back(int samples) const { return in_[size_t((n_ - samples) & (size_ - 1))]; } // 0 = newest

  // Normalised autocorrelation at one lag, on every `step`-th sample.
  inline float correlate(int lag, int window, int step) const {
    float c = 0, e0 = 1e-9f, e1 = 1e-9f;
    for (int i = 0; i < window; i += step) {
      const float a = back(i), b = back(i + lag);
      c += a * b;
      e0 += a * a;
      e1 += b * b;
    }
    return c / std::sqrt(e0 * e1);
  }
  // Pitch period by autocorrelation, in two passes so the audio thread never stalls on it: a
  // coarse sweep of every fourth lag on every fourth sample finds the neighbourhood, a fine one
  // around it finds the period. Of several equally good candidates (a period, two periods,
  // three…) the shortest is the true one.
  void measure() {
    const int window = maxPeriod_ * 2;
    float e0 = 0;
    for (int i = 0; i < window; i += 4) e0 += back(i) * back(i);
    if (e0 < 5e-8f * float(window)) return; // silence: keep the last period
    float best = 0;
    int count = 0;
    for (int lag = minPeriod_; lag <= maxPeriod_; lag += 4, count++) {
      score_[size_t(count)] = correlate(lag, window, 4);
      best = std::max(best, score_[size_t(count)]);
    }
    if (best < 0.4f) return; // unvoiced (s, sh, breath): any period will do, keep the last
    for (int j = 1; j + 1 < count; j++) {
      if (score_[size_t(j)] >= 0.88f * best && score_[size_t(j)] >= score_[size_t(j - 1)] && score_[size_t(j)] >= score_[size_t(j + 1)]) {
        const int around = minPeriod_ + 4 * j;
        float fine[9];
        int top = 1;
        for (int d = 0; d < 9; d++) fine[d] = correlate(around + d - 4, window, 2);
        for (int d = 2; d < 8; d++) if (fine[d] > fine[top]) top = d;
        // Between whole samples, a parabola through the peak.
        const float a = fine[top - 1], b = fine[top], c = fine[top + 1];
        const float shift = (a - c) / (2.0f * (a - 2.0f * b + c) - 1e-9f);
        const float lag = float(around + top - 4) + std::clamp(shift, -0.5f, 0.5f);
        period_ += (lag - period_) * 0.6f;
        return;
      }
    }
  }

  std::vector<float> in_, out_, score_;
  int size_ = 1, latency_ = 0, minPeriod_ = 120, maxPeriod_ = 600;
  int64_t n_ = 0;
  float period_ = 320;
  double synth_ = 0, source_ = 0;
};

// The effects stage, between the voice chain and the room/limiter. Everything is bypassed
// (one comparison per sample) until an effect is switched on.
class Effects {
 public:
  void prepare(float sr) {
    sr_ = sr;
    echo_.assign(size_t(0.65f * sr) + 8, 0.0f);
    pos_ = 0;
    ringPhase_ = tremPhase_ = 0;
    ringMix_ = echoMix_ = drive_ = tremDepth_ = 0;
    smooth_ = onePole(0.03f, sr);
  }
  void set(const Params& p) {
    ringStep_ = 2.0f * kPi * p.fxRingHz / sr_;
    ringTarget_ = p.fxRingHz > 0 ? p.fxRingMix : 0;
    const float wantEcho = p.fxEchoMs > 0 ? p.fxEchoMix : 0;
    if (wantEcho > 0 && echoTarget_ <= 0) std::fill(echo_.begin(), echo_.end(), 0.0f); // no stale tail from last time
    echoTarget_ = wantEcho;
    echoLen_ = std::clamp(int(p.fxEchoMs * 0.001f * sr_), 1, int(echo_.size()) - 1);
    echoFb_ = std::min(p.fxEchoFb, 0.85f);
    const bool phone = p.fxPhone > 0.5f;
    if (phone && !phone_) { hp_ = Biquad(); lp_ = Biquad(); }
    phone_ = phone;
    if (phone_) { hp_.highpass(sr_, 420, 0.8f); lp_.lowpass(sr_, 3200, 0.8f); }
    const bool muffle = p.fxLowpassHz > 0;
    if (muffle && !muffle_) low_ = Biquad();
    muffle_ = muffle;
    if (muffle_) low_.lowpass(sr_, p.fxLowpassHz, 0.9f);
    driveTarget_ = p.fxDrive;
    tremStep_ = 2.0f * kPi * p.fxTremHz / sr_;
    tremTarget_ = p.fxTremHz > 0 ? p.fxTremDepth : 0;
    wanted_ = ringTarget_ > 0 || echoTarget_ > 0 || phone_ || muffle_ || driveTarget_ > 0 || tremTarget_ > 0;
  }
  inline float process(float x) {
    if (!wanted_ && ringMix_ < 1e-4f && echoMix_ < 1e-4f && drive_ < 1e-4f && tremDepth_ < 1e-4f) return x;
    ringMix_ += (ringTarget_ - ringMix_) * smooth_;
    echoMix_ += (echoTarget_ - echoMix_) * smooth_;
    drive_ += (driveTarget_ - drive_) * smooth_;
    tremDepth_ += (tremTarget_ - tremDepth_) * smooth_;

    if (drive_ > 0.001f) x = std::tanh(x * (1.0f + drive_ * 24.0f)) / (1.0f + drive_ * 6.0f); // megaphone grit, level kept sane
    if (phone_) x = lp_.process(hp_.process(x)) * 1.6f;
    if (muffle_) x = low_.process(x);
    if (ringMix_ > 0.001f) { // multiply by a tone: the classic robot
      if ((ringPhase_ += ringStep_) > 2 * kPi) ringPhase_ -= 2 * kPi;
      x = x * (1.0f - ringMix_) + x * std::sin(ringPhase_) * ringMix_ * 1.4f;
    }
    if (tremDepth_ > 0.001f) {
      if ((tremPhase_ += tremStep_) > 2 * kPi) tremPhase_ -= 2 * kPi;
      x *= 1.0f - tremDepth_ * (0.5f + 0.5f * std::sin(tremPhase_));
    }
    const int size = int(echo_.size());
    const float delayed = echo_[size_t((pos_ + size - echoLen_) % size)];
    echo_[size_t(pos_)] = x + delayed * echoFb_;
    if (++pos_ >= size) pos_ = 0;
    return x + delayed * echoMix_;
  }

 private:
  float sr_ = 48000, smooth_ = 0;
  std::vector<float> echo_;
  int pos_ = 0, echoLen_ = 1;
  float echoFb_ = 0, echoMix_ = 0, echoTarget_ = 0;
  float ringStep_ = 0, ringPhase_ = 0, ringMix_ = 0, ringTarget_ = 0;
  float tremStep_ = 0, tremPhase_ = 0, tremDepth_ = 0, tremTarget_ = 0;
  float drive_ = 0, driveTarget_ = 0;
  bool phone_ = false, muffle_ = false, wanted_ = false;
  Biquad hp_, lp_, low_;
};

// Freeverb-style room: 8 damped combs + 4 all-passes per side.
class Room {
 public:
  void prepare(float sr) {
    static const int comb[8] = {1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617};
    static const int allp[4] = {556, 441, 341, 225};
    const float k = sr / 44100.0f;
    for (int side = 0; side < 2; side++) {
      for (int i = 0; i < 8; i++) combs_[side][i].resize(int((comb[i] + side * 23) * k) + 1);
      for (int i = 0; i < 4; i++) alls_[side][i].resize(int((allp[i] + side * 23) * k) + 1);
    }
  }
  inline void process(float in, float& l, float& r) {
    const float x = in * 0.015f;
    float out[2];
    for (int side = 0; side < 2; side++) {
      float acc = 0;
      for (auto& c : combs_[side]) acc += c.comb(x, 0.78f, 0.3f);
      for (auto& a : alls_[side]) acc = a.allpass(acc);
      out[side] = acc;
    }
    l = out[0];
    r = out[1];
  }

 private:
  struct Line {
    std::vector<float> buf;
    size_t idx = 0;
    float store = 0;
    void resize(int n) { buf.assign(size_t(n), 0.0f); idx = 0; store = 0; }
    inline float comb(float in, float feedback, float damp) {
      const float out = buf[idx];
      store = out * (1 - damp) + store * damp;
      buf[idx] = in + store * feedback;
      if (++idx >= buf.size()) idx = 0;
      return out;
    }
    inline float allpass(float in) {
      const float delayed = buf[idx];
      buf[idx] = in + delayed * 0.5f;
      if (++idx >= buf.size()) idx = 0;
      return delayed - in;
    }
  };
  Line combs_[2][8];
  Line alls_[2][4];
};

class Chain {
 public:
  void prepare(float sampleRate) {
    sr_ = sampleRate;
    hpf_.highpass(sr_, 85, 0.707f);
    exIn_.highpass(sr_, 3000, 0.707f);
    exOut_.highpass(sr_, 3000, 0.707f);
    for (int i = 0; i < 3; i++) { hum_[i] = Biquad(); hum_[i].notch(sr_, 50.0f * float(i + 1), 18.0f); }
    // Three bands, split by 4th-order Linkwitz-Riley crossovers (two Butterworth sections each).
    for (int i = 0; i < 2; i++) {
      xLoLp_[i] = Biquad(); xLoLp_[i].lowpass(sr_, 200, 0.707f);
      xLoHp_[i] = Biquad(); xLoHp_[i].highpass(sr_, 200, 0.707f);
      xHiLp_[i] = Biquad(); xHiLp_[i].lowpass(sr_, 4000, 0.707f);
      xHiHp_[i] = Biquad(); xHiHp_[i].highpass(sr_, 4000, 0.707f);
      kShelf_[i] = Biquad(); kShelf_[i].highshelf(sr_, 1682.0f, 4.0f); // K-weighting, as loudness meters hear
      kHigh_[i] = Biquad(); kHigh_[i].highpass(sr_, 38.0f, 0.5f);
    }
    satLp_ = Biquad(); satLp_.lowpass(sr_, 220, 0.707f);
    satHp_ = Biquad(); satHp_.highpass(sr_, 140, 0.707f);
    satTop_ = Biquad(); satTop_.lowpass(sr_, 900, 0.707f);
    const float attack[3] = {0.008f, 0.004f, 0.001f}, release[3] = {0.16f, 0.12f, 0.07f};
    for (int b = 0; b < 3; b++) { mbAtt_[b] = onePole(attack[b], sr_); mbRel_[b] = onePole(release[b], sr_); mbEnv_[b] = 0; mbG_[b] = 1; }
    mbAmt_ = satAmt_ = 0;
    loudMs_[0] = loudMs_[1] = 0; loudG_ = 1;
    loudCoef_ = onePole(0.4f, sr_);
    revHp_.highpass(sr_, 280, 0.707f);
    revLp_.lowpass(sr_, 6500, 0.707f);
    dyn_ = Dynamics();
    dyn_.prepare(sr_);
    room_.prepare(sr_);
    pitch_.prepare(sr_);
    natural_.prepare(sr_);
    fx_.prepare(sr_);
    delay_.assign(size_t(0.05f * sr_) + 8, 0.0f);
    delayPos_ = 0;
    smooth_ = onePole(0.03f, sr_);
    compAtt_ = onePole(0.004f, sr_);
    compRel_ = onePole(0.18f, sr_);
    limRel_ = onePole(0.06f, sr_);
    compDb_ = 0;
    limG_ = 1;
    phase1_ = phase2_ = 0;
    hasParams_ = false;
    setParams(Params());
    // Start from the targets instead of fading in from zero.
    inG_ = inT_; outG_ = outT_; makeup_ = makeupT_; exG_ = exT_; widthG_ = widthT_; revG_ = revT_;
  }

  // Cheap when nothing changed; call once per block on the audio thread.
  void setParams(const Params& p) {
    if (hasParams_ && std::memcmp(&p, &params_, sizeof(Params)) == 0) return;
    params_ = p;
    hasParams_ = true;
    hpf_.highpass(sr_, std::clamp(p.micHp, 40.0f, 200.0f), 0.707f);
    for (int i = 0; i < Params::kMicBands; i++) {
      const bool used = std::fabs(p.micG[i]) > 0.05f && p.micF[i] >= 20.0f;
      if (used && !micOn_[i]) mic_[i].reset();
      micOn_[i] = used;
      if (!used) continue;
      const float f = std::clamp(p.micF[i], 20.0f, 20000.0f), g = std::clamp(p.micG[i], -18.0f, 18.0f);
      if (p.micQ[i] < 0.05f) { if (f < 1000.0f) mic_[i].lowshelf(sr_, f, g); else mic_[i].highshelf(sr_, f, g); }
      else mic_[i].peaking(sr_, f, std::clamp(p.micQ[i], 0.2f, 12.0f), g);
    }
    low_.lowshelf(sr_, 150, p.warmth > 0.001f ? p.warmth * 7.5f - 1.0f : 0.0f); // all three at zero = flat: the window's frequency bands do the tone
    mud_.peaking(sr_, 300, 1.1f, -p.warmth * 3.5f);
    pres_.peaking(sr_, 3600, 0.9f, p.clarity * 6.0f);
    air_.highshelf(sr_, 10500, p.air * 9.0f);
    exT_ = p.excite >= 0.0f ? p.excite * 0.34f : p.clarity * 0.22f + p.air * 0.12f;
    thrDb_ = -12.0f - 26.0f * p.density;
    ratio_ = 2.0f + 5.0f * p.density;
    // Give back part of what the compressor takes, so "density" thickens rather than just gets louder.
    makeupT_ = dbToGain(0.3f * -thrDb_ * (1.0f - 1.0f / ratio_));
    widthT_ = p.width * 0.55f;
    revT_ = std::min(p.space + p.fxSpace, 1.6f) * 4.5f;
    gateThr_ = p.clean > 0.01f ? dbToGain(-65.0f + p.clean * 40.0f) : 1e-5f;
    inT_ = dbToGain(p.inGainDb);
    const float semitones = std::clamp(p.pitch + p.fxPitch, -14.0f, 14.0f);
    pitchRatio_ = std::fabs(semitones) < 0.01f ? 1.0f : std::pow(2.0f, semitones / 12.0f);
    // Every pitch change goes through the pitch-synchronous shifter: the plain one re-reads its
    // delay line, which doubles consonants on large shifts and is heard as a stutter. "Another
    // person" voices keep the timbre where it is (plus fxFormant); cartoon voices and the tone
    // slider move it about half as far as the pitch, which is what makes a giant sound big.
    const float timbre = p.fxNatural > 0.5f ? p.fxFormant : 0.55f * semitones;
    formantRatio_ = std::pow(2.0f, std::clamp(timbre, -5.0f, 5.0f) / 12.0f);
    useNatural_ = pitchRatio_ != 1.0f || std::fabs(timbre) > 0.01f;
    fx_.set(p);
    outT_ = dbToGain(p.outGainDb);
  }

  float gainReductionDb() const { return compDb_; }
  int latency() const { return useNatural_ ? natural_.latency() : 0; } // samples; everything else in the chain is immediate

  // `in` may alias `outL` (in-place).
  void process(const float* in, float* outL, float* outR, int frames) {
    const float deess = params_.deess;
    const bool autoLevel = params_.autoLevel > 0.5f;
    const float lfo1 = 2.0f * kPi * 0.31f / sr_, lfo2 = 2.0f * kPi * 0.43f / sr_;
    const float knee = 10.0f, slope = 1.0f / ratio_ - 1.0f;
    const float ceiling = 0.79f; // -2 dBFS
    const int size = int(delay_.size());

    for (int n = 0; n < frames; n++) {
      inG_ += (inT_ - inG_) * smooth_;
      outG_ += (outT_ - outG_) * smooth_;
      makeup_ += (makeupT_ - makeup_) * smooth_;
      exG_ += (exT_ - exG_) * smooth_;
      widthG_ += (widthT_ - widthG_) * smooth_;
      revG_ += (revT_ - revG_) * smooth_;

      float x = in[n] * inG_;
      if (useNatural_) x = natural_.process(x, pitchRatio_, formantRatio_);
      x = hpf_.process(x);
      if (params_.dehum > 0.5f) x = hum_[2].process(hum_[1].process(hum_[0].process(x)));
      for (int i = 0; i < Params::kMicBands; i++) if (micOn_[i]) x = mic_[i].process(x);
      x = dyn_.process(x, gateThr_, deess, autoLevel, params_.pop);
      x = air_.process(pres_.process(low_.process(mud_.process(x))));

      // "Broadcast": compress the lows, the middle and the top on their own, so the bass does not
      // swell and fade with the distance to the microphone and the top does not spit.
      mbAmt_ += (params_.multiband - mbAmt_) * smooth_;
      if (mbAmt_ > 0.002f) {
        const float lo = xLoLp_[1].process(xLoLp_[0].process(x));
        const float rest = xLoHp_[1].process(xLoHp_[0].process(x));
        const float band[3] = {lo, xHiLp_[1].process(xHiLp_[0].process(rest)), xHiHp_[1].process(xHiHp_[0].process(rest))};
        static const float thr[3] = {0.045f, 0.09f, 0.025f}, slope[3] = {0.62f, 0.3f, 0.6f}, lift[3] = {3.0f, 1.0f, 1.5f};
        float sum = 0;
        for (int b = 0; b < 3; b++) {
          const float a = std::fabs(band[b]);
          mbEnv_[b] += (a - mbEnv_[b]) * (a > mbEnv_[b] ? mbAtt_[b] : mbRel_[b]);
          // gain = (threshold / level) ^ slope above the threshold, then part of it given back
          const float want = (mbEnv_[b] > thr[b] ? std::pow(thr[b] / mbEnv_[b], slope[b] * mbAmt_) : 1.0f) * dbToGainFast(lift[b] * mbAmt_);
          mbG_[b] += (want - mbG_[b]) * 0.01f;
          sum += band[b] * mbG_[b];
        }
        x = sum;
      }
      // Low-end harmonics: the bass itself is inaudible on phones and laptops, its overtones are not.
      satAmt_ += (params_.satLow - satAmt_) * smooth_;
      if (satAmt_ > 0.002f) {
        const float lo = satLp_.process(x);
        const float shaped = (std::tanh(6.0f * lo + 0.3f) - 0.29131f) / (6.0f * 0.91514f); // biased: even and odd harmonics; unity slope at rest
        x += satTop_.process(satHp_.process(shaped - lo)) * satAmt_ * 1.8f;
      }

      // Soft-knee feed-forward compressor, no look-ahead (adds no latency).
      const float over = 20.0f * std::log10(std::fabs(x) + 1e-9f) - thrDb_;
      float target = 0;
      if (2 * over > knee) target = slope * over;
      else if (2 * over > -knee) target = slope * (over + knee / 2) * (over + knee / 2) / (2 * knee);
      compDb_ += (target - compDb_) * (target < compDb_ ? compAtt_ : compRel_);
      x *= dbToGain(compDb_) * makeup_;

      // Exciter: harmonics from the top of the voice, blended back in.
      const float t = fx_.process(x + exOut_.process(std::tanh(exIn_.process(x) * 6.0f)) * exG_);

      // Doubler: two slowly drifting taps panned apart.
      delay_[size_t(delayPos_)] = t;
      const float tap1 = tap((0.013f + 0.0012f * std::sin(phase1_)) * sr_, size);
      const float tap2 = tap((0.021f + 0.0016f * std::sin(phase2_)) * sr_, size);
      if (++delayPos_ >= size) delayPos_ = 0;
      if ((phase1_ += lfo1) > 2 * kPi) phase1_ -= 2 * kPi;
      if ((phase2_ += lfo2) > 2 * kPi) phase2_ -= 2 * kPi;

      float rl, rr;
      room_.process(revLp_.process(revHp_.process(t)), rl, rr);

      // The doubled taps go to the sides only (left plus, right minus). Voice chats fold the
      // microphone to mono, and there the taps cancel exactly: no comb filter, no slap-back.
      const float side = widthG_ * 0.75f * (tap1 - tap2);
      float l = t + side + rl * revG_;
      float r = t - side + rr * revG_;

      // Hold a loudness target (LUFS). Measured the way loudness meters do, only while there is
      // voice; moved slowly, faster when far off; within +-12 dB. The limiter below catches the peaks.
      if (params_.loudTarget < -1.0f) {
        const float kl = kHigh_[0].process(kShelf_[0].process(l)), kr = kHigh_[1].process(kShelf_[1].process(r));
        if (dyn_.open && std::fabs(t) > 0.003f) {
          loudMs_[0] += (kl * kl - loudMs_[0]) * loudCoef_;
          loudMs_[1] += (kr * kr - loudMs_[1]) * loudCoef_;
          const float now = -0.691f + 10.0f * std::log10(loudMs_[0] + loudMs_[1] + 1e-10f);
          const float want = dbToGain(std::clamp(params_.loudTarget - now, -12.0f, 12.0f));
          const float gap = std::fabs(want / loudG_ - 1.0f);
          loudG_ += (want - loudG_) * (gap > 0.6f ? 6.0f : 1.0f) / (2.0f * sr_);
        }
        l *= loudG_;
        r *= loudG_;
      } else {
        loudG_ += (1.0f - loudG_) * smooth_;
        l *= loudG_;
        r *= loudG_;
      }

      // Stereo-linked limiter: instant attack, 60 ms release.
      const float peak = std::max(std::fabs(l), std::fabs(r));
      const float want = peak > ceiling ? ceiling / peak : 1.0f;
      limG_ = want < limG_ ? want : limG_ + (want - limG_) * limRel_;
      outL[n] = std::clamp(l * limG_ * outG_, -1.0f, 1.0f);
      outR[n] = std::clamp(r * limG_ * outG_, -1.0f, 1.0f);
    }
  }

 private:
  inline float tap(float delaySamples, int size) const {
    float pos = float(delayPos_) - delaySamples;
    if (pos < 0) pos += float(size);
    const int i0 = int(pos);
    const int i1 = i0 + 1 >= size ? 0 : i0 + 1;
    const float frac = pos - float(i0);
    return delay_[size_t(i0)] * (1 - frac) + delay_[size_t(i1)] * frac;
  }

  float sr_ = 48000;
  Params params_;
  bool hasParams_ = false;
  Biquad hpf_, mud_, low_, pres_, air_, exIn_, exOut_, revHp_, revLp_;
  Biquad mic_[Params::kMicBands];
  Biquad hum_[3], xLoLp_[2], xLoHp_[2], xHiLp_[2], xHiHp_[2], kShelf_[2], kHigh_[2], satLp_, satHp_, satTop_;
  float mbEnv_[3] = {}, mbG_[3] = {1, 1, 1}, mbAtt_[3] = {}, mbRel_[3] = {}, mbAmt_ = 0, satAmt_ = 0;
  float loudMs_[2] = {}, loudG_ = 1, loudCoef_ = 0;
  bool micOn_[Params::kMicBands] = {};
  Dynamics dyn_;
  Room room_;
  PitchShifter pitch_;
  float pitchRatio_ = 1.0f, formantRatio_ = 1.0f;
  bool useNatural_ = false;
  NaturalShifter natural_;
  Effects fx_;
  std::vector<float> delay_;
  int delayPos_ = 0;
  float phase1_ = 0, phase2_ = 0;
  float smooth_ = 0, compAtt_ = 0, compRel_ = 0, limRel_ = 0;
  float thrDb_ = -26, ratio_ = 4, gateThr_ = 1e-5f;
  float compDb_ = 0, limG_ = 1;
  float inG_ = 1, inT_ = 1, outG_ = 1, outT_ = 1, makeup_ = 1, makeupT_ = 1;
  float exG_ = 0, exT_ = 0, widthG_ = 0, widthT_ = 0, revG_ = 0, revT_ = 0;
};

} // namespace aura
