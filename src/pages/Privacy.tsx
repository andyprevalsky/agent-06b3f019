import NaviHeader from "@/components/NaviHeader";
import NaviFooter from "@/components/NaviFooter";

const Privacy = () => {
  return (
    <div className="min-h-screen bg-background">
      <NaviHeader />
      
      <main className="pt-24 pb-16">
        <div className="container mx-auto px-6 max-w-4xl">
          <div className="prose prose-neutral dark:prose-invert max-w-none">
            <h1 className="text-4xl font-light tracking-tight mb-8 text-center">
              <span className="gradient-text">Privacy Policy</span>
            </h1>
            
            <p className="text-muted-foreground text-center mb-12">
              Last updated: August 5, 2025
            </p>
            
            <div className="space-y-8">
              <div className="bg-card/50 backdrop-blur-sm border border-border/50 rounded-lg p-6">
                <p className="text-lg leading-relaxed">
                  Your privacy is our top priority at Navi (hinavi.ai). This policy explains what we do not collect, how Navi works, and our commitment to your privacy.
                </p>
                <p className="mt-4 text-muted-foreground">
                  Visit <a href="/" className="text-primary hover:text-primary/80 underline transition-colors">www.hinavi.ai</a> to learn more about our service.
                </p>
              </div>

              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>

              <section>
                <h2 className="text-2xl font-semibold mb-4 text-foreground">1. Information We Collect</h2>
                <ul className="space-y-3 text-muted-foreground">
                  <li className="flex items-start space-x-3">
                    <div className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC]"></div>
                    <span>We do not store, record, or retain any conversations or personal data on our servers.</span>
                  </li>
                  <li className="flex items-start space-x-3">
                    <div className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC]"></div>
                    <span>All voice interactions are streamed in real time and discarded immediately. Navi only activates and listens when triggered by the wake word "Hi Navi."</span>
                  </li>
                  <li className="flex items-start space-x-3">
                    <div className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC]"></div>
                    <span>We do not use cookies, tracking pixels, or analytics scripts to monitor your activity on our website.</span>
                  </li>
                </ul>
              </section>

              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>

              <section>
                <h2 className="text-2xl font-semibold mb-4 text-foreground">2. How Navi Operates</h2>
                <ul className="space-y-3 text-muted-foreground">
                  <li className="flex items-start space-x-3">
                    <div className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC]"></div>
                    <span>Your voice input is never stored or processed by us. Navi serves as a pass-through to frontier AI model providers, exclusively during your active session.</span>
                  </li>
                  <li className="flex items-start space-x-3">
                    <div className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC]"></div>
                    <span>After your interaction ends, no data remains with Navi.</span>
                  </li>
                  <li className="flex items-start space-x-3">
                    <div className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC]"></div>
                    <span>We do not use your voice or interaction data for advertising, marketing, or profiling.</span>
                  </li>
                </ul>
              </section>

              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>

              <section>
                <h2 className="text-2xl font-semibold mb-4 text-foreground">3. Third-Party Processing</h2>
                <ul className="space-y-3 text-muted-foreground">
                  <li className="flex items-start space-x-3">
                    <div className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC]"></div>
                    <span>Voice data is securely and anonymously streamed to leading AI model providers strictly to generate your requested response.</span>
                  </li>
                  <li className="flex items-start space-x-3">
                    <div className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC]"></div>
                    <span>We do not sell, rent, or share any user data with advertisers, data brokers, or third parties.</span>
                  </li>
                  <li className="flex items-start space-x-3">
                    <div className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC]"></div>
                    <span>Our AI provider partners must adhere to strict privacy and security practices.</span>
                  </li>
                </ul>
              </section>

              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>

              <section>
                <h2 className="text-2xl font-semibold mb-4 text-foreground">4. Security</h2>
                <p className="text-muted-foreground">
                  All data in transit is encrypted using industry-standard protocols. No voice data is ever stored on our infrastructure.
                </p>
              </section>

              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>

              <section>
                <h2 className="text-2xl font-semibold mb-4 text-foreground">5. Your Control</h2>
                <ul className="space-y-3 text-muted-foreground">
                  <li className="flex items-start space-x-3">
                    <div className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC]"></div>
                    <span>Navi activates only in response to the wake word "Hi Navi."</span>
                  </li>
                  <li className="flex items-start space-x-3">
                    <div className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC]"></div>
                    <span>You can disable listening at any time by turning off your device.</span>
                  </li>
                  <li className="flex items-start space-x-3">
                    <div className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC]"></div>
                    <span>If you contact us via email or form, we use your contact details only to respond and do not retain them.</span>
                  </li>
                </ul>
              </section>

              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>

              <section>
                <h2 className="text-2xl font-semibold mb-4 text-foreground">6. Policy Updates</h2>
                <p className="text-muted-foreground">
                  We may amend this Privacy Policy occasionally. The latest version will always be available at <a href="/" className="text-primary hover:text-primary/80 underline transition-colors">www.hinavi.ai</a> with the date of last revision.
                </p>
              </section>

              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>

              <section>
                <h2 className="text-2xl font-semibold mb-4 text-foreground">7. Contact</h2>
                <p className="text-muted-foreground mb-2">
                  Have questions or concerns? Reach out anytime:
                </p>
                <p className="text-muted-foreground">
                  Email: <a href="mailto:andy@hinavi.ai" className="text-primary hover:text-primary/80 underline transition-colors">andy@hinavi.ai</a>
                </p>
              </section>

              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>

              <div className="text-center py-8">
                <p className="text-lg font-medium text-foreground">
                  Your privacy is our top priority at Navi. We're here to help—not to watch.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>

      <NaviFooter />
    </div>
  );
};

export default Privacy;