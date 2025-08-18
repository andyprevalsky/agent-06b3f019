import { useEffect, useRef, useState } from "react";

type ConversationPair = {
  user: string;
  navi: string;
};

const PAIRS: ConversationPair[] = [
  {
    user: "Hi Navi, can you make sure I stay healthy?",
    navi:
      "Sure! I’ll make sure to remind you during our daily check-in to take your meds because I know you’ve been inconsistent with them, schedule the doctor appointments you need when they come up, and I’ll monitor your Apple Watch for anything that looks off.",
  },
  {
    user:
      "Hey Navi, I really want to make sure I get into Stanford, can you do that for me?",
    navi:
      "Of course! Getting in requires excellent academic performance and out-of-school projects. Given your affinity for math, I’ll reach out to college math professors near you to get you started with a summer research program and find the best SAT prep school for your learning style.",
  },
  {
    user:
      "Hi Navi, I want to be a better partner & friend, can you ensure I show up as my best self for the people I care about?",
    navi:
      "No worries, we all have our moments and I would be more than happy to help. I’ll take a look at your recent conversations to figure out where you seem to fall short, help you consistently reach out with kindness, and work with you on whatever problems seem to be holding you back!",
  },
  {
    user:
      "Hi Navi, I just moved and need to get my house up and running to support me as quickly as possible, can you help?",
    navi:
      "What an exciting new opportunity! I’ll research what would help you the most in getting set up and place an Amazon order for you.",
  },
  {
    user:
      "Hey Navi, I have an idea for a business I want to start, can you make sure I get over the initial hump of starting it?",
    navi:
      "I’ve got your back! Let me know what kind of business it is, and I’ll set you up with a website, reach out to influencers in your niche to get some initial traction going, and apply to all applicable grants so you have some cushion, too!",
  },
];

type Phase = "typingUser" | "transforming" | "typingNavi" | "pause";

const typeText = (
  fullText: string,
  setter: (v: string) => void,
  onDone: () => void,
  speed: number = 24
) => {
  let index = 0;
  const step = () => {
    if (index <= fullText.length) {
      setter(fullText.slice(0, index));
      index += 1;
      setTimeout(step, speed);
    } else {
      onDone();
    }
  };
  step();
};

interface SeamlessConversationsProps {
  embedded?: boolean;
}

const SeamlessConversations = ({ embedded = false }: SeamlessConversationsProps) => {
  const [pairIndex, setPairIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("typingUser");
  const [typedUser, setTypedUser] = useState("");
  const [typedNavi, setTypedNavi] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);
  const userBoxRef = useRef<HTMLDivElement>(null);
  const naviBoxRef = useRef<HTMLDivElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);

  // Drive the animation phases
  useEffect(() => {
    const current = PAIRS[pairIndex];
    if (!current) return;

    if (phase === "typingUser") {
      setTypedUser("");
      setTypedNavi("");
      typeText(current.user, setTypedUser, () => setPhase("transforming"), 18);
    } else if (phase === "transforming") {
      // Create a floating clone and animate from user box to navi box
      const container = containerRef.current;
      const userEl = userBoxRef.current;
      const naviEl = naviBoxRef.current;
      const floating = floatingRef.current;
      if (!container || !userEl || !naviEl || !floating) return;

      const containerRect = container.getBoundingClientRect();
      const startRect = userEl.getBoundingClientRect();
      const endRect = naviEl.getBoundingClientRect();

      const startLeft = startRect.left - containerRect.left;
      const startTop = startRect.top - containerRect.top;
      const endLeft = endRect.left - containerRect.left;
      const endTop = endRect.top - containerRect.top;

      const scaleX = endRect.width / startRect.width;
      const scaleY = endRect.height / startRect.height;

      // Initialize floating at start position
      floating.style.display = "block";
      floating.style.left = `${startLeft}px`;
      floating.style.top = `${startTop}px`;
      floating.style.width = `${startRect.width}px`;
      floating.style.height = `${startRect.height}px`;
      floating.style.opacity = "1";
      floating.innerText = current.user;

      // Force layout to ensure transition kicks in
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      floating.offsetHeight;

      floating.style.transition = "transform 500ms ease, opacity 500ms ease";
      const translateX = endLeft - startLeft;
      const translateY = endTop - startTop;
      floating.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`;

      const timer = setTimeout(() => {
        floating.style.opacity = "0";
        setPhase("typingNavi");
      }, 520);
      return () => clearTimeout(timer);
    } else if (phase === "typingNavi") {
      typeText(current.navi, setTypedNavi, () => setPhase("pause"), 14);
    } else if (phase === "pause") {
      const timer = setTimeout(() => {
        setPairIndex((prev) => (prev + 1) % PAIRS.length);
        setPhase("typingUser");
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [pairIndex, phase]);

  if (embedded) {
    return (
      <div ref={containerRef} className="w-full h-full relative p-3 md:p-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4 items-start h-full">
          {/* User input box */}
          <div className="relative">
            <div
              ref={userBoxRef}
              className="rounded-xl border border-black/80 bg-card text-foreground p-3 md:p-4 min-h-[100px]"
            >
              <div
                className="text-xs md:text-sm leading-relaxed transition-opacity duration-300"
                style={{ opacity: phase === "transforming" ? 0 : 1 }}
              >
                {typedUser}
                {phase === "typingUser" && <span className="opacity-60">|</span>}
              </div>
            </div>
          </div>

          {/* Navi output box */}
          <div className="relative">
            <div className="relative bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC] bg-[length:200%_200%] animate-gradient-rotate p-[2px] rounded-xl">
              <div ref={naviBoxRef} className="rounded-[10px] bg-background p-3 md:p-4 min-h-[100px]">
                <div className="text-xs md:text-sm leading-relaxed">
                  {typedNavi}
                  {phase === "typingNavi" && <span className="opacity-60">|</span>}
                </div>
              </div>
            </div>
          </div>

          {/* Floating transforming copy */}
          <div
            ref={floatingRef}
            className="pointer-events-none absolute z-20 flex items-center justify-start rounded-xl border border-black/80 bg-card text-foreground p-3 md:p-4"
            style={{ display: "none", transformOrigin: "top left" }}
            aria-hidden
          />
        </div>
      </div>
    );
  }

  return (
    <section className="relative py-16 md:py-24">
      <div className="container mx-auto px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl md:text-3xl font-semibold text-center mb-8 md:mb-12">Seamless conversations</h2>

          <div ref={containerRef} className="relative w-full mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6 md:gap-8 items-start">
            {/* User input box */}
            <div className="relative">
              <div
                ref={userBoxRef}
                className="rounded-xl border border-black/80 bg-card text-foreground p-5 md:p-6 min-h-[120px]"
              >
                <div
                  className="text-sm md:text-base leading-relaxed transition-opacity duration-300"
                  style={{ opacity: phase === "transforming" ? 0 : 1 }}
                >
                  {typedUser}
                  {phase === "typingUser" && (
                    <span className="opacity-60">|</span>
                  )}
                </div>
              </div>
              <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 lg:hidden select-none" aria-hidden>
                <span className="text-muted-foreground">↓</span>
              </div>
            </div>

            {/* Navi output box with animated gradient border like feature cards */}
            <div className="relative">
              <div className="relative bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC] bg-[length:200%_200%] animate-gradient-rotate p-[2px] rounded-xl">
                <div
                  ref={naviBoxRef}
                  className="rounded-[10px] bg-background p-5 md:p-6 min-h-[120px]"
                >
                  <div className="text-sm md:text-base leading-relaxed">
                    {typedNavi}
                    {phase === "typingNavi" && (
                      <span className="opacity-60">|</span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Floating transforming copy */}
            <div
              ref={floatingRef}
              className="pointer-events-none absolute z-20 flex items-center justify-start rounded-xl border border-black/80 bg-card text-foreground p-5 md:p-6"
              style={{ display: "none", transformOrigin: "top left" }}
              aria-hidden
            />
          </div>

          {/* Small helper row with visual arrow on large screens */}
          <div className="hidden lg:flex items-center justify-center gap-2 text-muted-foreground mt-3 select-none" aria-hidden>
            <span>User</span>
            <span>→</span>
            <span>Navi</span>
          </div>
        </div>
      </div>
    </section>
  );
};

export default SeamlessConversations;

