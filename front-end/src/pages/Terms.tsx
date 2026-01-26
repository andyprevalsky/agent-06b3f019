/**
 * STATE MACHINE: Terms
 *
 * This component is stateless - displays static terms of service content.
 *
 * [MOUNTED] --> renders static content
 */

import NaviHeader from "@/components/NaviHeader";
import NaviFooter from "@/components/NaviFooter";

const Terms = () => {
  return (
    <div className="min-h-screen bg-background">
      <NaviHeader />
      
      <main className="pt-24 pb-16">
        <div className="container mx-auto px-6 max-w-4xl">
          <div className="prose prose-neutral dark:prose-invert max-w-none">
            <h1 className="text-4xl font-light tracking-tight mb-8 text-center">
              <span className="gradient-text">Terms of Service</span>
            </h1>
            
            <p className="text-muted-foreground text-center mb-12">
              Last updated: August 5, 2025
            </p>
            
            <div className="space-y-8">
              <div className="bg-card/50 backdrop-blur-sm border border-border/50 rounded-lg p-6">
                <p className="text-lg leading-relaxed">
                  Welcome to <a href="/" className="text-primary hover:text-primary/80 underline transition-colors">https://roselabs.ai</a> ("Rose Labs", "we", "us", or "our"). By using our website or joining our waitlist, you agree to these Terms of Service. Please read them carefully.
                </p>
              </div>

              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>

              <section>
                <h2 className="text-2xl font-semibold mb-4 text-foreground">1. Use of Our Website</h2>
                <p className="text-muted-foreground">
                  You may use <a href="/" className="text-primary hover:text-primary/80 underline transition-colors">https://roselabs.ai</a> only for lawful purposes. You agree not to misuse the website, attempt to gain unauthorized access, or disrupt the site's functionality.
                </p>
              </section>

              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>

              <section>
                <h2 className="text-2xl font-semibold mb-4 text-foreground">2. Waitlist Sign-Up</h2>
                <p className="text-muted-foreground">
                  If you join our waitlist, you agree to provide accurate information. By signing up, you consent to us contacting you by email about Rose Labs updates and news. You can unsubscribe at any time.
                </p>
              </section>

              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>

              <section>
                <h2 className="text-2xl font-semibold mb-4 text-foreground">3. Intellectual Property</h2>
                <p className="text-muted-foreground">
                  All content on this site—including text, branding, images, and design—is owned by Rose Labs and may not be used without our permission.
                </p>
              </section>

              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>

              <section>
                <h2 className="text-2xl font-semibold mb-4 text-foreground">4. No Warranties</h2>
                <p className="text-muted-foreground">
                  <a href="/" className="text-primary hover:text-primary/80 underline transition-colors">https://roselabs.ai</a> is provided "as is." We make no guarantees about the accuracy, reliability, or availability of our website or information on it.
                </p>
              </section>

              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>

              <section>
                <h2 className="text-2xl font-semibold mb-4 text-foreground">5. Limitation of Liability</h2>
                <p className="text-muted-foreground">
                  To the fullest extent permitted by law, Rose Labs is not liable for any damages or losses arising from your use of this site.
                </p>
              </section>

              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>

              <section>
                <h2 className="text-2xl font-semibold mb-4 text-foreground">6. Links to Other Sites</h2>
                <p className="text-muted-foreground">
                  Our website may link to third-party sites. We are not responsible for their content or privacy practices.
                </p>
              </section>

              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>

              <section>
                <h2 className="text-2xl font-semibold mb-4 text-foreground">7. Changes to These Terms</h2>
                <p className="text-muted-foreground">
                  We may update these Terms from time to time. The latest version will always be posted on this page with the effective date.
                </p>
              </section>

              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>

              <section>
                <h2 className="text-2xl font-semibold mb-4 text-foreground">8. Contact</h2>
                <p className="text-muted-foreground mb-2">
                  Questions about these Terms?
                </p>
                <p className="text-muted-foreground">
                  Contact: <a href="mailto:andy@roselabs.ai" className="text-primary hover:text-primary/80 underline transition-colors">andy@roselabs.ai</a>
                </p>
              </section>

              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>

              <div className="text-center py-8">
                <p className="text-lg font-medium text-foreground">
                  By using this website, you agree to these Terms of Service.
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

export default Terms;