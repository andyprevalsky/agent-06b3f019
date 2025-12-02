#!/usr/bin/env tsx

/**
 * Cleanup Script: Delete All Person Records and Integrations
 * 
 * This script will:
 * 1. Delete all MessageRecord entries (cascaded via Person deletion)
 * 2. Delete all Person records
 * 3. Delete all EmailIntegrationCredential entries (cascaded via Integration deletion)
 * 4. Delete all Integration records
 */

import { prisma } from '../src/lib/prisma';
import * as dotenv from 'dotenv';

dotenv.config();

async function cleanupIntegrations() {
  console.log('🧹 Starting cleanup of all persons and integrations...\n');

  try {
    // Get counts before deletion
    const personCount = await prisma.person.count();
    const messageRecordCount = await prisma.messageRecord.count();
    const integrationCount = await prisma.integration.count();
    const emailCredentialCount = await prisma.emailIntegrationCredential.count();

    console.log('📊 Current records in database:');
    console.log(`   Persons: ${personCount}`);
    console.log(`   Message Records: ${messageRecordCount}`);
    console.log(`   Integrations: ${integrationCount}`);
    console.log(`   Email Credentials: ${emailCredentialCount}`);
    console.log('');

    if (personCount === 0 && integrationCount === 0) {
      console.log('✅ No records to clean up!');
      return;
    }

    // Delete all message records first (or let cascade handle it)
    console.log('🗑️  Deleting all message records...');
    const deletedMessageRecords = await prisma.messageRecord.deleteMany({});
    console.log(`   ✅ Deleted ${deletedMessageRecords.count} message record(s)`);

    // Delete all persons
    console.log('🗑️  Deleting all persons...');
    const deletedPersons = await prisma.person.deleteMany({});
    console.log(`   ✅ Deleted ${deletedPersons.count} person(s)`);

    // Delete all email integration credentials first (or let cascade handle it)
    console.log('🗑️  Deleting all email integration credentials...');
    const deletedEmailCredentials = await prisma.emailIntegrationCredential.deleteMany({});
    console.log(`   ✅ Deleted ${deletedEmailCredentials.count} email credential(s)`);

    // Delete all integrations
    console.log('🗑️  Deleting all integrations...');
    const deletedIntegrations = await prisma.integration.deleteMany({});
    console.log(`   ✅ Deleted ${deletedIntegrations.count} integration(s)`);

    console.log('\n' + '='.repeat(60));
    console.log('📈 Cleanup Summary:');
    console.log(`   Message Records deleted: ${deletedMessageRecords.count}`);
    console.log(`   Persons deleted: ${deletedPersons.count}`);
    console.log(`   Email Credentials deleted: ${deletedEmailCredentials.count}`);
    console.log(`   Integrations deleted: ${deletedIntegrations.count}`);
    console.log('='.repeat(60));

    console.log('\n✅ All persons and integrations cleaned up successfully!');

  } catch (error) {
    console.error('❌ Fatal error during cleanup:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run cleanup
cleanupIntegrations()
  .then(() => {
    console.log('\n👋 Cleanup complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Cleanup failed:', error);
    process.exit(1);
  });


