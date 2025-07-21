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

const CustomDesignForm = () => {
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
    <section className="py-24 bg-gradient-to-b from-surface to-background">
      <div className="container mx-auto px-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center max-w-6xl mx-auto">
          
          {/* Custom Design Image */}
          <div className="relative reveal-up">
            <img 
              src="https://images.unsplash.com/photo-1488590528505-98d2b5aba04b?w=600&h=400&fit=crop&crop=center" 
              alt="Custom Design Navi"
              className="w-3/4 h-auto mx-auto rounded-lg"
            />
            <div className="mt-4 text-center">
              <h2 className="text-3xl font-bold mb-2">Custom Design</h2>
              <p className="text-muted-foreground mb-2 text-lg font-medium">Starting at $299</p>
              <p className="text-muted-foreground">
                Ready to bring your unique vision to life? Fill out the form and we'll get back to you with a custom quote.
              </p>
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

export default CustomDesignForm;