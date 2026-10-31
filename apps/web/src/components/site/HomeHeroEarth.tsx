"use client";

import { useReducedMotion } from "@/lib/useReducedMotion";

import styles from "./HomeHeroClasses";

const POSTER = "/videos/earth-horizon-poster.jpg";

export default function HomeHeroEarth() {
  const reducedMotion = useReducedMotion();

  return (
    <div className={styles.earth} aria-hidden="true">
      {reducedMotion ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={POSTER} alt="" className={styles.earthMedia} />
      ) : (
        <video
          className={styles.earthMedia}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster={POSTER}
          disablePictureInPicture
        >
          <source src="/videos/earth-horizon.mp4" type="video/mp4" />
        </video>
      )}
      <span className={styles.earthVeil} />
    </div>
  );
}
