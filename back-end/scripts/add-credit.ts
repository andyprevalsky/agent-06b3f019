/**
 * Add credit to a user by phone number
 * 
 * Usage: npx tsx scripts/add-credit.ts "+18724633855" 500
 *   - First arg: Phone number (E.164 format)
 *   - Second arg: Amount in cents (default: 500 = $5.00)
 */

import { createClient } from '@supabase/supabase-js';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

const prisma = new PrismaClient();

async function addCredit(phoneNumber: string, amountCents: number) {
  // Normalize phone number - remove spaces, dashes, parentheses
  const normalizedPhone = phoneNumber.replace(/[\s\-\(\)]/g, '');
  
  console.log(`🔍 Looking for user with phone: ${normalizedPhone}`);

  // Find user by phone number using Supabase Admin API
  const { data: { users }, error } = await supabase.auth.admin.listUsers();
  
  if (error) {
    console.error('❌ Error listing users:', error.message);
    process.exit(1);
  }

  const user = users.find(u => {
    const userPhone = u.phone?.replace(/[\s\-\(\)]/g, '');
    return userPhone === normalizedPhone;
  });

  if (!user) {
    console.error(`❌ No user found with phone number: ${normalizedPhone}`);
    console.log('\nAvailable users with phones:');
    users.filter(u => u.phone).forEach(u => {
      console.log(`  - ${u.phone} (${u.id})`);
    });
    process.exit(1);
  }

  console.log(`✅ Found user: ${user.id}`);
  console.log(`   Phone: ${user.phone}`);
  console.log(`   Email: ${user.email || 'N/A'}`);

  // Ensure user exists in Prisma User table
  let prismaUser = await prisma.user.findUnique({
    where: { userId: user.id }
  });

  if (!prismaUser) {
    console.log(`📝 Creating user record in database...`);
    prismaUser = await prisma.user.create({
      data: { userId: user.id }
    });
  }

  // Add credit
  const credit = await prisma.credit.create({
    data: {
      userId: user.id,
      amountCents: amountCents,
      expirationDate: null, // Never expires
    }
  });

  const amountDollars = amountCents / 100;
  console.log(`\n✅ Added $${amountDollars.toFixed(2)} credit to user ${user.id}`);
  console.log(`   Credit ID: ${credit.id}`);
  console.log(`   Amount: ${amountCents} cents ($${amountDollars.toFixed(2)})`);
  console.log(`   Expiration: Never`);

  // Show total credits
  const allCredits = await prisma.credit.findMany({
    where: { userId: user.id }
  });
  
  const totalCents = allCredits.reduce((sum, c) => sum + c.amountCents, 0);
  console.log(`\n📊 User's total credits: $${(totalCents / 100).toFixed(2)}`);
}

// Parse args
const phoneArg = process.argv[2];
const amountArg = process.argv[3];

if (!phoneArg) {
  console.log('Usage: npx tsx scripts/add-credit.ts "+18724633855" 500');
  console.log('  - First arg: Phone number (E.164 format)');
  console.log('  - Second arg: Amount in cents (default: 500 = $5.00)');
  process.exit(1);
}

const amountCents = amountArg ? parseInt(amountArg, 10) : 500;

addCredit(phoneArg, amountCents)
  .catch(console.error)
  .finally(() => prisma.$disconnect());


