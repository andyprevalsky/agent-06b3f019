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
  const [isSubmitted, setIsSubmitted] = useState(false);
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
    e.preventDefault();
    setEmailError('');

    // Validate email
    if (!validateEmail(formData.email)) {
      setEmailError('Please enter a valid email address');
      return;
    }

    setIsLoading(true);

    // Simulate form submission
    try {
      // Simple delay to simulate processing
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      console.log('Form submitted:', formData);
      setIsSubmitted(true);
      onSuccess?.();
    } catch (error) {
      console.error('Error submitting form:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleInputChange = (field: keyof typeof formData) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({
      ...prev,
      [field]: e.target.value
    }));
  };

  if (isSubmitted) {
    return (
      <Card className="w-full max-w-md mx-auto">
        <CardContent className="p-6 text-center">
          <div className="mb-4">
            <Check className="w-12 h-12 text-green-500 mx-auto" />
          </div>
          <h3 className="text-lg font-semibold mb-2">You're on the list!</h3>
          <p className="text-muted-foreground">
            We'll notify you when Navi becomes available. Keep an eye on your inbox!
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!isExpanded) {
    return (
      <div className="text-center">
        <Button 
          onClick={() => setIsExpanded(true)}
          size="lg"
          className="px-16"
        >
          Join Waitlist
          <ChevronDown className="w-4 h-4 ml-2" />
        </Button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md mx-auto animate-in slide-in-from-top-2 duration-300">
      <Card className="w-full overflow-hidden">
        <CardContent className="px-0 py-0">
          <form onSubmit={handleSubmit} className="space-y-0">
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
  );
}

export default WaitlistForm; 