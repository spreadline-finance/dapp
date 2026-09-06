"use client";
import { LottieLight as Lottie, type LottieHandle } from "lottie-react";
import { useEffect, useRef, useState } from "react";
import { useInView, useReducedMotion } from "motion/react";
import { Pause, Play } from "lucide-react";
export default function ExecutionAnimation() {
  const host = useRef<HTMLDivElement>(null);
  const animation = useRef<LottieHandle>(null);
  const visible = useInView(host);
  const reduced = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const [data, setData] = useState<object>();
  useEffect(() => {
    const controller = new AbortController();
    fetch("/animations/execution-loop.json", { signal: controller.signal })
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (visible && !reduced && !paused) animation.current?.play();
    else animation.current?.pause();
  }, [visible, reduced, paused, data]);
  return (
    <div
      ref={host}
      className="execution-animation"
      aria-label="Illustration of USDG passing through two pools and returning to USDG"
    >
      <div aria-hidden="true">
        {data ? (
          <Lottie
            lottieRef={animation}
            src={data}
            style={{ height: "100%", width: "100%" }}
            subscriptions={{
              ready: () => {
                if (visible && !reduced && !paused) animation.current?.play();
              },
            }}
            autoplay={false}
            loop
          />
        ) : (
          <div className="animation-fallback">
            USDG <span>→</span> STOCK TOKEN <span>→</span> USDG
          </div>
        )}
      </div>
      <button
        className="animation-control"
        aria-label={
          paused ? "Play execution animation" : "Pause execution animation"
        }
        onClick={() => setPaused(!paused)}
        disabled={!!reduced}
      >
        {paused || reduced ? <Play size={12} /> : <Pause size={12} />}
      </button>
    </div>
  );
}
