#!/bin/bash

# Stripe Webhook Testing Script
# Tests webhook events using Stripe CLI

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  🔔 Stripe Webhook Test Script"
echo "════════════════════════════════════════════════════════════"
echo ""

# Check if Stripe CLI is installed
if ! command -v stripe &> /dev/null; then
    echo -e "${RED}❌ Stripe CLI is not installed${NC}"
    echo ""
    echo "Install it from: https://stripe.com/docs/stripe-cli"
    echo "Or run: brew install stripe/stripe-cli/stripe"
    exit 1
fi

echo -e "${GREEN}✅ Stripe CLI found${NC}"
echo ""

# Check if logged in to Stripe
if ! stripe config --list &> /dev/null; then
    echo -e "${YELLOW}⚠️  Not logged in to Stripe${NC}"
    echo "Running: stripe login"
    stripe login
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  📋 Available Tests"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "1. Test invoice.payment_succeeded (THE ONLY EVENT WE NEED!)"
echo "2. Listen to all webhooks with ngrok (public URL)"
echo "3. Listen to all webhooks locally (stripe forward)"
echo ""
echo -n "Select test (1-3): "
read -r choice

# Get backend URL
BACKEND_URL="${BACKEND_URL:-http://localhost:3001}"
echo ""
echo -e "${YELLOW}Using backend URL: $BACKEND_URL${NC}"
echo ""

case $choice in
    1)
        echo -e "${GREEN}🧪 Testing invoice.payment_succeeded${NC}"
        echo ""
        echo "This is THE ONLY EVENT WE TRACK!"
        echo "Covers: Initial purchase, renewals, all payments."
        echo ""
        echo -e "${YELLOW}Note: You need to run 'stripe listen' in another terminal first!${NC}"
        echo ""
        echo "1. Open another terminal"
        echo "2. Run: stripe listen --forward-to $BACKEND_URL/webhooks/stripe"
        echo "3. Then trigger the event with:"
        echo ""
        echo -e "${YELLOW}stripe trigger invoice.payment_succeeded${NC}"
        echo ""
        read -p "Press Enter to trigger the event (or Ctrl+C to cancel)..."
        stripe trigger invoice.payment_succeeded
        ;;
    2)
        echo -e "${GREEN}🌐 Setting up ngrok + webhook listener...${NC}"
        echo ""
        echo "This will:"
        echo "1. Start ngrok tunnel to port 3001 (with --pooling-enabled)"
        echo "2. Forward Stripe webhooks through the public ngrok URL"
        echo ""
        
        # Check if ngrok is installed
        if ! command -v ngrok &> /dev/null; then
            echo -e "${RED}❌ ngrok is not installed${NC}"
            echo ""
            echo "Install it from: https://ngrok.com/download"
            echo "Or run: brew install ngrok"
            exit 1
        fi
        
        echo -e "${YELLOW}Starting ngrok tunnel to port 3001...${NC}"
        echo ""
        echo "1. Open another terminal"
        echo "2. Run: ngrok http 3001 --pooling-enabled"
        echo "3. Copy the 'Forwarding' URL (e.g., https://xxxx.ngrok.io)"
        echo "4. Come back here and paste it"
        echo ""
        echo -n "Enter ngrok URL: "
        read -r NGROK_URL
        
        # Remove trailing slash if present
        NGROK_URL="${NGROK_URL%/}"
        
        echo ""
        echo -e "${GREEN}🎧 Starting webhook listener with ngrok URL...${NC}"
        echo ""
        echo "Forwarding to: $NGROK_URL/webhooks/stripe"
        echo ""
        echo "Press Ctrl+C to stop."
        echo ""
        stripe listen --forward-to "$NGROK_URL/webhooks/stripe"
        ;;
    3)
        echo -e "${GREEN}🎧 Starting webhook listener (local)...${NC}"
        echo ""
        echo "This will forward ALL Stripe webhooks to your local server."
        echo "We only process 'invoice.payment_succeeded' - all others are ignored."
        echo ""
        echo "Press Ctrl+C to stop."
        echo ""
        echo "After this starts, open another terminal and run:"
        echo -e "${YELLOW}stripe trigger invoice.payment_succeeded${NC}"
        echo ""
        echo "Starting listener..."
        echo ""
        stripe listen --forward-to "$BACKEND_URL/webhooks/stripe"
        ;;
    *)
        echo -e "${RED}❌ Invalid choice${NC}"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}✅ Test complete!${NC}"
echo ""
echo "Check your backend logs for webhook processing details."
echo ""

