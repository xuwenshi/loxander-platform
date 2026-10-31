import styles from "./HomeHeroClasses";

export default function HomeHeroTransit() {
  return (
    <div className={styles.transit} aria-hidden="true">
      <svg viewBox="0 0 1440 900" preserveAspectRatio="none">
        <defs>
          <filter
            id="home-hero-transit-glow"
            x="-300%"
            y="-300%"
            width="700%"
            height="700%"
          >
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <path
            id="home-hero-transit-path"
            d="M 1120 248 C 1020 314 922 392 806 430 C 676 474 538 510 398 586 C 278 650 156 690 42 705"
          />
        </defs>

        <use className={styles.transitGhost} href="#home-hero-transit-path" />
        <use className={styles.transitPath} href="#home-hero-transit-path" />

        <circle className={styles.transitPacketRing} r="7">
          <animateMotion dur="10.8s" repeatCount="indefinite" begin="1.4s">
            <mpath href="#home-hero-transit-path" />
          </animateMotion>
          <animate
            attributeName="opacity"
            values="0;0;0.42;0.26;0"
            dur="10.8s"
            repeatCount="indefinite"
            begin="1.4s"
          />
        </circle>

        <circle className={styles.transitTail} r="1.5" opacity="0.42">
          <animateMotion dur="10.8s" repeatCount="indefinite" begin="0.9s">
            <mpath href="#home-hero-transit-path" />
          </animateMotion>
        </circle>
        <circle className={styles.transitTail} r="1" opacity="0.2">
          <animateMotion dur="10.8s" repeatCount="indefinite" begin="0.4s">
            <mpath href="#home-hero-transit-path" />
          </animateMotion>
        </circle>

        <circle className={styles.transitPacket} r="2.4">
          <animateMotion dur="10.8s" repeatCount="indefinite" begin="1.4s">
            <mpath href="#home-hero-transit-path" />
          </animateMotion>
        </circle>
      </svg>
    </div>
  );
}
