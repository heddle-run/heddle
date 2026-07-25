import { HomeLayout } from "fumadocs-ui/layouts/home";
import Hero from "@/components/Hero";
import { GITHUB_URL } from "@/lib/constants";

export default function Home() {
  return (
    <HomeLayout
      className="landing-page"
      nav={{
        title: (
          <span className="font-semibold tracking-tight">heddle</span>
        ),
        url: "/",
      }}
      links={[
        { text: "Docs", url: "/docs" },
      ]}
      githubUrl={GITHUB_URL}
    >
      <Hero />
    </HomeLayout>
  );
}
