import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { variant } = await req.json();
    
    // Fake Stripe key for now - replace with real key later
    const stripe = new Stripe("sk_test_fake_key_replace_with_real", {
      apiVersion: "2023-10-16",
    });

    const prices = {
      white: 19900, // $199.00 in cents
      black: 19900, // $199.00 in cents
    };

    const productNames = {
      white: "Navi - Pearl White",
      black: "Navi - Midnight Black",
    };

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: productNames[variant as keyof typeof productNames],
              description: "Revolutionary voice AI hardware device",
            },
            unit_amount: prices[variant as keyof typeof prices],
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${req.headers.get("origin")}/payment-success`,
      cancel_url: `${req.headers.get("origin")}`,
      allow_promotion_codes: true,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});