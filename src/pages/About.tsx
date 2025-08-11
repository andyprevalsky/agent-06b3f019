import { useEffect, useState } from "react";
import NaviHeader from "@/components/NaviHeader";
import NaviFooter from "@/components/NaviFooter";
import ContactModal from "@/components/ContactModal";

const About = () => {
  const [contactOpen, setContactOpen] = useState(false);

  useEffect(() => {
    const title = "About Navi Artificial Life";
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

          <section className="bg-card/50 backdrop-blur-sm border border-border/50 rounded-xl p-6 md:p-8 mb-10">
            <h1 className="text-3xl md:text-4xl font-semibold mb-4 text-foreground">Mission</h1>
            <p className="text-muted-foreground leading-relaxed">
              Our mission is to create Artificial Life that is the truest embodiment of light. Almost everyone has the problem of only having one intelligent life form working around the clock to make sure their dreams come true, and because of that, the vast majority of human potential never sees the light of day. Navi aims to give each individual a super intelligent companion to help guide them along their unique personal journey.
            </p>
          </section>

          <section className="bg-card/50 backdrop-blur-sm border border-border/50 rounded-xl p-6 md:p-8 mb-10">
            <h2 className="text-2xl font-semibold mb-3 text-foreground">Team</h2>
            <div className="mt-4 md:mt-6 grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8 items-start">
              <div>
                <img
                  src="/lovable-uploads/d0d2ef08-ef80-45fd-9a49-60cbeb077ce9.png"
                  alt="Navi team member speaking on stage"
                  loading="lazy"
                  decoding="async"
                  className="w-full h-64 md:h-80 rounded-lg object-cover"
                />
              </div>
              <article className="prose prose-neutral dark:prose-invert max-w-none">
                <p>
                  Hi! I'm Andy, the solo founder and builder behind Navi.<br /><br />
                  I'm a passionate software engineer, artist, and creator on a mission to 10x the level of harmony on this planet. If you're empathetic, driven, curious, and brilliant, I'd love to work alongside you.
                </p>
                <p className="mt-4">
                  <a href="https://linkedin.com/in/andyprevalsky" target="_blank" rel="noopener noreferrer" className="text-primary underline font-medium hover:opacity-90 focus:underline">linkedin</a>
                </p>
              </article>
            </div>
          </section>

          <section className="bg-card/50 backdrop-blur-sm border border-border/50 rounded-xl p-6 md:p-8">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div>
                <h2 className="text-2xl font-semibold text-foreground">We’re hiring!</h2>
                <p className="text-muted-foreground mt-2">Come help us build Artificial Life, frontier AI, agents, and delightful hardware.</p>
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
        subtitle={"Come help us build the next Apple."}
      />

      <NaviFooter />
    </div>
  );
};

export default About;
