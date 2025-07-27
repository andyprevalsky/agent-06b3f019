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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

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


  return (
    <section className="py-24 bg-gradient-to-b from-surface to-background">
      <div className="container mx-auto px-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 max-w-6xl mx-auto">
          
          {/* Custom Design Form - Matching waitlist card structure */}
          <div className="w-full">
            <Card className="group bg-card border-border/50 hover:border-primary/30 transition-all duration-500 hover:shadow-[var(--shadow-luxury)] hover:scale-105 reveal-up">
              <CardContent className="p-8 text-center">
                <div className="mb-6">
                  <div className="w-72 h-72 rounded-3xl mx-auto mb-4 overflow-hidden bg-gradient-to-br from-purple-100 to-orange-100 flex items-center justify-center">
                    <img 
                      src="https://images.unsplash.com/photo-1488590528505-98d2b5aba04b?w=288&h=288&fit=crop&crop=center" 
                      alt="Custom Design Navi"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <h3 className="text-2xl font-semibold mb-2">Custom Design</h3>
                  <p className="text-muted-foreground">Starting at $299. Bring your unique vision to life</p>
                </div>
              </CardContent>
            </Card>
            
            {/* Custom Design Request Button */}
            <div className="mt-6">
              <Button 
                onClick={() => {
                  // Create mailto link with custom design request
                  const subject = encodeURIComponent("Custom Design Request");
                  const body = encodeURIComponent(
                    "Hi, I'm interested in a custom Navi design!\n\n" +
                    "Please include:\n" +
                    "• Your name\n" +
                    "• Email address\n" +
                    "• Phone number\n" +
                    "• Detailed description of your custom design vision\n\n" +
                    "We'll respond within 24 hours with a custom quote."
                  );
                  window.location.href = `mailto:andyprevalsky@fastmail.com?subject=${subject}&body=${body}`;
                }}
                className="w-full"
              >
                Request Custom Design
              </Button>
              <p className="text-xs text-muted-foreground mt-4 text-center">
                We'll respond within 24 hours with a custom quote
              </p>
            </div>
          </div>
          
          {/* Full Form in Second Column */}
          <div className="lg:col-span-2 reveal-up">
            <Card className="bg-card/50 backdrop-blur-sm border-border/50 h-full">
              <CardHeader>
                <CardTitle className="text-2xl text-center">Custom Design Details</CardTitle>
              </CardHeader>
            <CardContent>
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
          
        </div>
     </div>
   </section>
  );
};

export default CustomDesignForm;