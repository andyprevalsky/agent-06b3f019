import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";

const customDesignSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  phone: z.string().min(1, "Phone number is required"),
  description: z.string().min(10, "Please provide at least 10 characters describing your custom design")
});

type CustomDesignForm = z.infer<typeof customDesignSchema>;

const ProductShowcase = () => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();

  const form = useForm<CustomDesignForm>({
    resolver: zodResolver(customDesignSchema),
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
    <section className="py-24 bg-gradient-to-b from-background to-surface relative overflow-hidden">
      <div className="container mx-auto px-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center max-w-6xl mx-auto mb-24">
          
          {/* Black Navi */}
          <div className="relative reveal-up">
            <img 
              src="/lovable-uploads/91e751a7-115a-416b-b7b3-9e7cee11584b.png" 
              alt="Navi in Midnight Black"
              className="w-3/4 h-auto mx-auto"
            />
            <div className="mt-4 text-center">
              <h3 className="text-2xl font-semibold mb-2">Midnight Black</h3>
              <p className="text-muted-foreground">Precision-crafted aluminum with a deep, sophisticated finish</p>
            </div>
          </div>
          
          {/* White Navi */}
          <div className="relative reveal-up reveal-delay-1">
            <img 
              src="/lovable-uploads/08d900d5-b4c6-43d7-8e90-87a13069cd14.png" 
              alt="Navi in Pearl White"
              className="w-3/4 h-auto mx-auto"
            />
            <div className="mt-4 text-center">
              <h3 className="text-2xl font-semibold mb-2">Pearl White</h3>
              <p className="text-muted-foreground">Lustrous ceramic-like finish that captures and reflects light</p>
            </div>
          </div>
          
        </div>
        
        <div className="text-center mt-16 mb-16 reveal-up reveal-delay-2">
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Every Navi device is meticulously crafted with premium materials, 
            featuring precision-engineered perforations that optimize both acoustics and aesthetics.
          </p>
        </div>

        {/* Custom Design Section */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center max-w-6xl mx-auto mt-24">
          
          {/* Custom Design Image */}
          <div className="relative reveal-up">
            <img 
              src="https://images.unsplash.com/photo-1488590528505-98d2b5aba04b?w=600&h=400&fit=crop&crop=center" 
              alt="Custom Design Navi"
              className="w-3/4 h-auto mx-auto rounded-lg"
            />
            <div className="mt-4 text-center">
              <h3 className="text-2xl font-semibold mb-2">Custom Design</h3>
              <p className="text-muted-foreground mb-2">Starting at $299</p>
              <p className="text-muted-foreground">Bring your unique vision to life with a personalized Navi device</p>
            </div>
          </div>
          
          {/* Custom Design Form */}
          <div className="reveal-up reveal-delay-1">
            <Card className="bg-card/50 backdrop-blur-sm border-border/50">
              <CardHeader>
                <CardTitle className="text-2xl text-center">Request Custom Design</CardTitle>
              </CardHeader>
              <CardContent>
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                    <FormField
                      control={form.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Name</FormLabel>
                          <FormControl>
                            <Input placeholder="Your full name" {...field} />
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
                          <FormLabel>Email</FormLabel>
                          <FormControl>
                            <Input type="email" placeholder="your@email.com" {...field} />
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
                          <FormLabel>Phone</FormLabel>
                          <FormControl>
                            <Input placeholder="Your phone number" {...field} />
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
                          <FormLabel>Design Description</FormLabel>
                          <FormControl>
                            <Textarea 
                              placeholder="Describe your custom design vision in detail..."
                              className="min-h-[120px]"
                              {...field} 
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    
                    <Button 
                      type="submit" 
                      className="w-full" 
                      disabled={isSubmitting}
                    >
                      {isSubmitting ? "Sending Request..." : "Send Custom Design Request"}
                    </Button>
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

export default ProductShowcase;