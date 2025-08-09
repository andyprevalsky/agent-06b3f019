import { useEffect, useState } from "react";
import NaviHeader from "@/components/NaviHeader";
import NaviFooter from "@/components/NaviFooter";
import ContactModal from "@/components/ContactModal";

const About = () => {
  const [contactOpen, setContactOpen] = useState(false);

  useEffect(() => {
    const title = "About Navi — Artificial Life";
    const description = "Learn about Navi's mission to create Artificial Life and the story behind founder Andy Prevalsky.";
    document.title = title;

    const ensureMeta = (name: string, content: string) => {
      let tag = document.querySelector(`meta[name="${name}"]`);
      if (!tag) {
        tag = document.createElement("meta");
        tag.setAttribute("name", name);
        document.head.appendChild(tag);
      }
      tag.setAttribute("content", content);
    };

    ensureMeta("description", description);

    // Canonical
    let link = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.rel = "canonical";
      document.head.appendChild(link);
    }
    link.href = window.location.href;
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <NaviHeader />
      <main className="pt-24 pb-20">
        <div className="container mx-auto px-6 max-w-4xl">
          <header className="text-center mb-12">
            <h1 className="text-4xl font-light tracking-tight mb-4">
              <span className="gradient-text">About Navi</span>
            </h1>
            <p className="text-muted-foreground">
              Building Artificial Life — thoughtfully and pragmatically.
            </p>
          </header>

          <section className="bg-card/50 backdrop-blur-sm border border-border/50 rounded-xl p-6 md:p-8 mb-10">
            <h2 className="text-2xl font-semibold mb-3 text-foreground">Our Mission</h2>
            <p className="text-muted-foreground leading-relaxed">
              Our mission is to create Artificial Life that is the truest embodiment of light — that people love and trust. Almost everyone has the problem of only having one intelligent life-form working around the clock to make sure their dreams come true, and because of that, the vast majority of human potential never sees the light of day. Navi aims to give each individual a super intelligent companion to help guide them along their unique personal journey.
            </p>
          </section>

          <section className="bg-card/50 backdrop-blur-sm border border-border/50 rounded-xl p-6 md:p-8 mb-10">
            <h2 className="text-2xl font-semibold mb-3 text-foreground">About Andy</h2>
            <article className="prose prose-neutral dark:prose-invert max-w-none">
              <p>
                Hi, I’m Andy Prevalsky — previous founder (YC S20) and now building Navi. Navi’s goal is simple and ambitious: create Artificial Life. We’re starting with a
                hackable smart‑home speaker for spawning agents toward any long‑term goal, then steadily increasing hardware complexity toward a physically intelligent companion.
              </p>
              <p>
                Why? Most people have only one intelligent lifeform working 24/7 to improve their lives: themselves. A super‑intelligent companion can reduce daily friction, amplify potential, and meaningfully alleviate real‑world pain. This is a trillion‑dollar opportunity — the Apple of AI.
              </p>
              <p>
                I’ve spent the last 7 years building AI/ML products — from college projects (LSTM/Markov trading bots) to staff engineering at Vapi (YC Voice AI), to leading product, strategy, and distribution at a previous YC‑backed startup with mentorship from Michael Seibel. I studied Electrical & Computer Engineering and have shipped custom models that drove the majority of user growth in prior work.
              </p>
              <p>
                I’m now working full‑time on Navi. You can learn more at <a href="https://www.hinavi.ai" className="text-primary hover:underline">hinavi.ai</a>.
              </p>
            </article>
          </section>

          <section className="bg-card/50 backdrop-blur-sm border border-border/50 rounded-xl p-6 md:p-8">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div>
                <h2 className="text-2xl font-semibold text-foreground">We’re hiring!</h2>
                <p className="text-muted-foreground mt-2">Come help us build Artificial Life — frontier AI, agents, and delightful hardware.</p>
              </div>
              <button
                onClick={() => setContactOpen(true)}
                className="px-5 py-2 rounded-md border border-border/60 hover:bg-secondary/60 transition-colors"
              >
                Get in touch
              </button>
            </div>
          </section>
        </div>
      </main>

      <ContactModal
        open={contactOpen}
        onOpenChange={setContactOpen}
        subtitle={"We’re hiring! Please send your resume and a short blurb to andy@hinavi.ai."}
      />

      <NaviFooter />
    </div>
  );
};

export default About;
