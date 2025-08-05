

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import WaitlistForm from "./WaitlistForm";
import VideoPlayer from "./VideoPlayer";

const WaitlistSection = () => {
  return (
    <section id="waitlist" className="py-32 bg-gradient-to-b from-surface to-background relative overflow-hidden">
      <div className="container mx-auto px-6">
        <div className="text-center mb-16">
          <Badge variant="outline" className="mb-4 px-4 py-2 text-sm border-primary/20 text-primary">
            Limited Early Access
          </Badge>
          <h2 className="text-5xl font-light tracking-tight mb-6 reveal-up">
            <span className="gradient-text">Join the Waitlist</span>
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto reveal-up reveal-delay-1">
            Be among the first to experience the future of voice AI. 
            Join our waitlist and we'll notify you when you are next in line.
          </p>
          
          <div className="text-center mt-8 mb-8 reveal-up reveal-delay-2">
            <p className="text-sm text-muted-foreground mb-3">Available in 3 variations</p>
            <div className="flex justify-center space-x-6">
              <div className="group relative flex flex-col items-center">
                <div 
                  className="w-3 h-3 rounded-full transition-transform duration-200 hover:scale-140 cursor-pointer" 
                  style={{ backgroundColor: '#010203' }}
                  title="Midnight Black"
                ></div>
                <span className="absolute top-6 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-300 whitespace-nowrap">
                  Midnight Black
                </span>
              </div>
              <div className="group relative flex flex-col items-center">
                <div 
                  className="w-3 h-3 rounded-full border border-gray-300 transition-transform duration-200 hover:scale-140 cursor-pointer" 
                  style={{ backgroundColor: '#F0F0FF' }}
                  title="Pearl White"
                ></div>
                <span className="absolute top-6 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-300 whitespace-nowrap">
                  Pearl White
                </span>
              </div>
              <div className="group relative flex flex-col items-center">
                <div 
                  className="w-3 h-3 rounded-full transition-transform duration-200 hover:scale-140 cursor-pointer" 
                  style={{ background: 'linear-gradient(135deg, #A76CED, #E062CC, #FD5776, #FE7503)' }}
                  title="Custom"
                ></div>
                <span className="absolute top-6 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-300 whitespace-nowrap">
                  Custom
                </span>
              </div>
            </div>
          </div>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto">
          
          {/* Midnight Black with Waitlist */}
          <div className="w-full">
            <Card className="group bg-card border-border/50 hover:border-primary/30 transition-all duration-500 hover:shadow-[var(--shadow-luxury)] hover:scale-105 reveal-up reveal-delay-1">
              <CardContent className="p-8 text-center">
                 <div className="mb-6">
                  <div className="w-72 h-72 rounded-3xl mx-auto mb-4 overflow-hidden bg-surface">
                    <VideoPlayer
                      src="/navi-black-v4-white-background.webm"
                      poster="/navi-midnight-black-white-background.png"
                      className="w-full h-full object-cover"
                      fallbackContent={
                        <img src="/navi-midnight-black-white-background.png" alt="Navi Black" className="w-full h-full object-cover" />
                      }
                    />
                  </div>
                  <h3 className="text-2xl font-semibold mb-2">Midnight Black</h3>
                  <p className="text-muted-foreground">Precision matte coating with subtle metallic undertones</p>
                </div>
              </CardContent>
            </Card>
            
            {/* Waitlist Form for Midnight Black */}
            <div className="mt-6">
              <WaitlistForm 
                onSuccess={() => console.log('User joined waitlist successfully!')}
              />
              <p className="text-xs text-muted-foreground mt-4 text-center">
                No commitment • Early access updates
              </p>
            </div>
          </div>
          
          {/* Pearl White with Waitlist */}
          <div className="w-full">
            <Card className="group bg-surface-elevated border-border/50 hover:border-space-gray/30 transition-all duration-500 hover:shadow-[var(--shadow-luxury)] hover:scale-105 reveal-up reveal-delay-2">
              <CardContent className="p-8 text-center">
                 <div className="mb-6">
                  <div className="w-72 h-72 rounded-3xl mx-auto mb-4 overflow-hidden bg-surface">
                    <VideoPlayer
                      src="/navi-white-v4-white-background.webm"
                      poster="/navi-pearl-white-white-background.png"
                      className="w-full h-full object-cover"
                      fallbackContent={
                        <img src="/navi-pearl-white-white-background.png" alt="Navi White" className="w-full h-full object-cover" />
                      }
                    />
                  </div>
                  <h3 className="text-2xl font-semibold mb-2">Pearl White</h3>
                  <p className="text-muted-foreground">Lustrous ceramic-like finish that captures and reflects light</p>
                </div>
              </CardContent>
            </Card>
            
            {/* Waitlist Form for Pearl White */}
            <div className="mt-6">
              <WaitlistForm 
                onSuccess={() => console.log('User joined waitlist successfully!')}
              />
              <p className="text-xs text-muted-foreground mt-4 text-center">
                No commitment • Early access updates
              </p>
            </div>
          </div>
          
          {/* Custom with Waitlist */}
          <div className="w-full">
            <Card className="group bg-card border-border/50 hover:border-primary/30 transition-all duration-500 hover:shadow-[var(--shadow-luxury)] hover:scale-105 reveal-up reveal-delay-3">
              <CardContent className="p-8 text-center">
                 <div className="mb-6">
                  <div className="w-72 h-72 rounded-3xl mx-auto mb-4 overflow-hidden bg-gradient-to-br from-purple-100 to-orange-100 flex items-center justify-center">
                    <div className="text-6xl font-light text-transparent bg-gradient-to-br from-[#A76CED] via-[#E062CC] to-[#FE7503] bg-clip-text">
                      ?
                    </div>
                  </div>
                  <h3 className="text-2xl font-semibold mb-2">Custom</h3>
                  <p className="text-muted-foreground">Bring your favorite character to life with a custom design, voice, & personality</p>
                </div>
              </CardContent>
            </Card>
            
            {/* Waitlist Form for Custom */}
            <div className="mt-6">
              <WaitlistForm 
                onSuccess={() => console.log('User joined waitlist successfully!')}
              />
              <p className="text-xs text-muted-foreground mt-4 text-center">
                No commitment • Early access updates
              </p>
            </div>
          </div>
          
        </div>
        
        <div className="text-center mt-12 reveal-up reveal-delay-3">
          <p className="text-sm text-muted-foreground mb-4">
            Expected launch: Q3 2025 • Join early for exclusive updates
          </p>
        </div>
      </div>


    </section>
  );
};

export default WaitlistSection;
