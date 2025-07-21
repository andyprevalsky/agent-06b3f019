import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { HelpCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const customDesignSchema = z.object({
  name: z.string()
    .min(2, "Name must be at least 2 characters")
    .max(50, "Name must be less than 50 characters")
    .regex(/^[a-zA-Z\s]+$/, "Name can only contain letters and spaces"),
  email: z.string()
    .min(1, "Email is required")
    .email("Please enter a valid email address")
    .max(100, "Email must be less than 100 characters"),
  phone: z.string()
    .min(1, "Phone number is required")
    .regex(/^[\+]?[1-9][\d]{0,15}$/, "Please enter a valid phone number")
    .min(10, "Phone number must be at least 10 digits")
    .max(17, "Phone number must be less than 17 characters"),
  description: z.string()
    .min(20, "Please provide at least 20 characters describing your custom design")
    .max(1000, "Description must be less than 1000 characters")
    .refine((val) => val.trim().split(' ').length >= 5, {
      message: "Please provide at least 5 words in your description"
    })
});

type CustomDesignForm = z.infer<typeof customDesignSchema>;

const CustomDesignForm = () => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();

  const form = useForm<CustomDesignForm>({
    resolver: zodResolver(customDesignSchema),
    mode: "onChange", // Enable real-time validation
    defaultValues: {
      name: "",
      email: "",
      phone: "",
      description: ""
    }
  });

  const onSubmit = async (data: CustomDesignForm) => {
    setIsSubmitting(true);
    try {
      // Create mailto link with form data
      const subject = encodeURIComponent("Custom Design Request from " + data.name);
      const body = encodeURIComponent(
        `Name: ${data.name}\n` +
        `Email: ${data.email}\n` +
        `Phone: ${data.phone}\n\n` +
        `Description:\n${data.description}`
      );
      
      window.location.href = `mailto:andyprevalsky@fastmail.com?subject=${subject}&body=${body}`;
      
      toast({
        title: "Request Sent",
        description: "Your custom design request has been prepared. Please send the email from your default email client."
      });
      
      form.reset();
    } catch (error) {
      toast({
        title: "Error",
        description: "There was a problem preparing your request. Please try again.",
        variant: "destructive"
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleServiceFeeClick = (e: React.MouseEvent) => {
    e.preventDefault();
    document.getElementById('service-fee')?.scrollIntoView({ 
      behavior: 'smooth',
      block: 'start'
    });
  };

  return (
    <section className="py-24 bg-gradient-to-b from-surface to-background">
      <div className="container mx-auto px-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center max-w-6xl mx-auto">
          
          {/* Custom Design Form */}
          <div className="reveal-up">
            <Card className="bg-card/50 backdrop-blur-sm border-border/50">
              <CardHeader>
                <CardTitle className="text-2xl text-center">Request Custom Design</CardTitle>
              </CardHeader>
            <CardContent>
              {/* Image and Description */}
              <div className="text-center mb-6 pb-6 border-b border-border/20">
                <img 
                  src="https://images.unsplash.com/photo-1488590528505-98d2b5aba04b?w=300&h=200&fit=crop&crop=center" 
                  alt="Custom Design Navi"
                  className="w-2/3 h-auto mx-auto rounded-lg mb-3"
                />
                <p className="text-sm text-muted-foreground">
                  Starting at $299 + 
                  <button 
                    onClick={handleServiceFeeClick}
                    className="text-xs text-primary hover:underline cursor-pointer ml-1 inline-flex items-center gap-1"
                  >
                    service fee
                    <HelpCircle size={10} />
                  </button>
                </p>
                <p className="text-sm text-muted-foreground mt-1">Bring your unique vision to life with a personalized Navi device.</p>
              </div>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Full Name *</FormLabel>
                        <FormControl>
                          <Input 
                            placeholder="Enter your full name" 
                            {...field}
                            className={form.formState.errors.name ? "border-destructive" : ""}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email Address *</FormLabel>
                        <FormControl>
                          <Input 
                            type="email" 
                            placeholder="your.email@example.com" 
                            {...field}
                            className={form.formState.errors.email ? "border-destructive" : ""}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Phone Number *</FormLabel>
                        <FormControl>
                          <Input 
                            placeholder="+1 (555) 123-4567" 
                            {...field}
                            className={form.formState.errors.phone ? "border-destructive" : ""}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={form.control}
                    name="description"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Design Description *</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <Textarea 
                              placeholder="Describe your custom design vision in detail... Include colors, materials, patterns, or any specific features you'd like."
                              className={`min-h-[120px] resize-none ${form.formState.errors.description ? "border-destructive" : ""}`}
                              {...field} 
                            />
                            <div className="absolute bottom-2 right-2 text-xs text-muted-foreground">
                              {field.value.length}/1000
                            </div>
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <Button 
                    type="submit" 
                    className="w-full" 
                    disabled={isSubmitting || !form.formState.isValid}
                  >
                    {isSubmitting ? "Sending Request..." : "Send Custom Design Request"}
                  </Button>
                  
                  <p className="text-xs text-muted-foreground text-center mt-2">
                    * Required fields. We'll respond within 24 hours with a custom quote.
                  </p>
                 </form>
               </Form>
             </CardContent>
            </Card>
          </div>
          
          {/* Empty second column for spacing */}
          <div></div>
          
        </div>
     </div>
   </section>
  );
};

export default CustomDesignForm;