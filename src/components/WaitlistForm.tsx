"use client";
import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronDown, Mail, User, Check } from "lucide-react";

interface WaitlistFormInput {
  onSuccess?: () => void;
}

function WaitlistForm({ onSuccess }: WaitlistFormInput) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    email: ''
  });
  const [emailError, setEmailError] = useState('');



  const validateEmail = (email: string) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); // Always prevent default to avoid page jumps
    setEmailError('');

    // Validate email before submission
    if (!validateEmail(formData.email)) {
      setEmailError('Please enter a valid email address');
      return;
    }

    setIsLoading(true);

    // Let Viral Loops handle the submission
    setTimeout(() => {
      console.log('Form submitted to Viral Loops:', formData);
      setIsLoading(false);
      onSuccess?.();
    }, 1000);
  };

  const handleInputChange = (field: keyof typeof formData) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({
      ...prev,
      [field]: e.target.value
    }));
  };

  return (
    <>
      {/* Collapsed state - Button sits outside any card */}
      {!isExpanded && (
        <div className="w-full">
          <Button 
            onClick={(e) => {
              e.preventDefault();
              setIsExpanded(true);
            }}
            size="lg"
            className="w-full"
            disabled={isLoading}
          >
            {isLoading ? 'Loading...' : 'Join Waitlist'}
          </Button>
        </div>
      )}
      
      {/* Expanded state - Form inside card with animation */}
      {isExpanded && (
        <div className="w-full animate-in slide-in-from-top-2 duration-300">
          {/* Join Stage - Viral Loops will hide this after participation */}
          <div 
            data-vl-campaign-id="cpdWm9oR9IFjRr3SNkkR59rxXiE" 
            data-vl-container="join-stage"
          >
            <Card className="w-full overflow-hidden">
              <CardContent className="px-0 py-0">
                <form 
                  data-vl-action="join-stage#join" 
                  onSubmit={handleSubmit} 
                  className="space-y-0"
                >
                  <div className="px-6 py-6 space-y-4">
                    <div className="space-y-2 text-left">
                      <Label htmlFor="name" className="block text-left">Name</Label>
                      <div className="relative">
                        <User className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
                        <Input
                          id="name"
                          type="text"
                          placeholder="John Doe"
                          value={formData.name}
                          onChange={handleInputChange('name')}
                          data-vl-join-stage-target="input.firstname"
                          className="pl-10"
                          required
                        />
                      </div>
                    </div>
                    
                    <div className="space-y-2 text-left">
                      <Label htmlFor="email" className="block text-left">Email</Label>
                      <div className="relative">
                        <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
                        <Input
                          id="email"
                          type="email"
                          placeholder="john@example.com"
                          value={formData.email}
                          onChange={handleInputChange('email')}
                          data-vl-join-stage-target="input.email"
                          className="pl-10"
                          required
                        />
                      </div>
                      {emailError && (
                        <p className="text-sm text-red-500">{emailError}</p>
                      )}
                    </div>
                  </div>
                  
                  <Button 
                    type="submit" 
                    className="w-full rounded-none" 
                    disabled={isLoading}
                  >
                    {isLoading ? 'Joining...' : 'Join Waitlist'}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>

          {/* Sharing Stage - Viral Loops will show this after participation */}
          <div 
            data-vl-campaign-id="cpdWm9oR9IFjRr3SNkkR59rxXiE" 
            data-vl-container="sharing-stage"
          >
            <Card className="w-full overflow-hidden">
              <CardContent className="px-0 py-0">
                {React.createElement('form-widget', {
                  ucid: 'cpdWm9oR9IFjRr3SNkkR59rxXiE'
                })}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

export default WaitlistForm; 