import CosmicLink from "@/components/cosmic/CosmicLink";
import Starfield from "@/components/cosmic/Starfield";

import HomeHeroEarth from "./HomeHeroEarth";
import styles from "./HomeHeroClasses";
import HomeHeroOrbit from "./HomeHeroOrbit";
import HomeHeroTransit from "./HomeHeroTransit";

const STATUS = [
  { key: "Now building", value: "RAG 检索评估" },
  { key: "Last transmission", value: "2026.10.08" },
  { key: "Orbital status", value: "Stable / 5 regions" },
  { key: "Frame / Complete", value: "Deep-space observatory" },
] as const;

export default function HomeHero() {
  return (
    <section className={`${styles.hero} cosmic-enter`}>
      <HomeHeroEarth />
      <Starfield className={styles.starfield} />
      <HomeHeroTransit />

      <div className={styles.inner}>
        <div className={styles.copy}>
          <p className={styles.eyebrow}>Loxander / Signal origin / 31.23° N</p>

          <h1 className={styles.title}>
            <span>在深空里，</span>
            <span>构建能被理解、</span>
            <span>复现与信任的系统。</span>
          </h1>

          <p className={styles.deck}>
            机器学习工程师。这里记录可验证的项目、写下来的思考，
            以及生活里尚未命名的部分。
          </p>

          <div className={styles.actions}>
            <CosmicLink
              href="/universe"
              variant="warp"
              className={styles.primary}
            >
              进入星图
              <span aria-hidden="true">↗</span>
            </CosmicLink>
            <CosmicLink
              href="/projects"
              variant="soft"
              className={styles.secondary}
            >
              查看项目
            </CosmicLink>
          </div>
        </div>

        <HomeHeroOrbit />

        <dl className={styles.status}>
          {STATUS.map((item) => (
            <div key={item.key}>
              <dt>{item.key}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
