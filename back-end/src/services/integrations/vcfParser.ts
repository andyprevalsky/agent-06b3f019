import { prisma } from '../../lib/prisma';

export interface ParsedVCard {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string | null;
  emails: string[];
  phone: string | null;
  phones: string[];
  company: string | null;
  title: string | null;
  uid: string | null;
}

/**
 * Parse a VCF (vCard) file content into structured contact data
 */
export function parseVcfContent(vcfContent: string): ParsedVCard[] {
  const contacts: ParsedVCard[] = [];
  
  // Split into individual vCards
  const vcardBlocks = vcfContent.split(/(?=BEGIN:VCARD)/i).filter(block => block.trim());
  
  for (const block of vcardBlocks) {
    if (!block.includes('BEGIN:VCARD')) continue;
    
    const contact = parseVCard(block);
    if (contact && (contact.email || contact.firstName || contact.lastName)) {
      contacts.push(contact);
    }
  }
  
  return contacts;
}

function parseVCard(vcardText: string): ParsedVCard | null {
  // Handle line folding (lines starting with space/tab are continuations)
  const unfoldedText = vcardText.replace(/\r?\n[ \t]/g, '');
  const lines = unfoldedText.split(/\r?\n/);
  
  let firstName = '';
  let lastName = '';
  let fullName = '';
  const emails: string[] = [];
  const phones: string[] = [];
  let company: string | null = null;
  let title: string | null = null;
  let uid: string | null = null;
  
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    
    const fieldPart = line.substring(0, colonIndex);
    const valuePart = line.substring(colonIndex + 1).trim();
    
    // Extract field name (before any parameters like ;TYPE=...)
    const fieldName = fieldPart.split(';')[0].toUpperCase();
    
    switch (fieldName) {
      case 'FN':
        fullName = valuePart.trim();
        break;
        
      case 'N':
        // N format: LastName;FirstName;MiddleName;Prefix;Suffix
        const nameParts = valuePart.split(';');
        lastName = (nameParts[0] || '').trim();
        firstName = (nameParts[1] || '').trim();
        break;
        
      case 'EMAIL':
        if (valuePart && !valuePart.includes('@reply.') && !valuePart.includes('@hous.')) {
          emails.push(valuePart.toLowerCase().trim());
        }
        break;
        
      case 'TEL':
        if (valuePart) {
          phones.push(valuePart.trim());
        }
        break;
        
      case 'ORG':
        // ORG format: Company;Department
        const orgParts = valuePart.split(';');
        company = (orgParts[0] || '').trim() || null;
        break;
        
      case 'TITLE':
        title = valuePart.trim() || null;
        break;
        
      case 'UID':
        uid = valuePart.trim() || null;
        break;
    }
  }
  
  // If no first/last name but we have fullName, try to split it
  if (!firstName && !lastName && fullName) {
    const parts = fullName.split(' ');
    if (parts.length >= 2) {
      firstName = parts[0];
      lastName = parts.slice(1).join(' ');
    } else if (parts.length === 1) {
      firstName = parts[0];
    }
  }
  
  // Skip contacts that are just craigslist or empty
  if (fullName.toLowerCase().includes('craigslist') || 
      (emails.length === 1 && emails[0].includes('craigslist'))) {
    return null;
  }
  
  return {
    firstName,
    lastName,
    fullName: fullName || `${firstName} ${lastName}`.trim(),
    email: emails[0] || null,
    emails,
    phone: phones[0] || null,
    phones,
    company,
    title,
    uid,
  };
}

/**
 * Import parsed VCF contacts into the database as Person records
 */
export async function importVcfContacts(
  userId: string,
  contacts: ParsedVCard[]
): Promise<{ created: number; updated: number; skipped: number }> {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  
  for (const contact of contacts) {
    if (!contact.email && !contact.phone) {
      skipped++;
      continue;
    }
    
    try {
      // Try to find existing person by email
      let existingPerson = null;
      
      if (contact.email) {
        existingPerson = await prisma.person.findFirst({
          where: {
            userId,
            OR: [
              { email: contact.email },
              { emailAddresses: { array_contains: [contact.email] } },
            ],
          },
        });
      }
      
      // If not found by email, try by phone
      if (!existingPerson && contact.phone) {
        existingPerson = await prisma.person.findFirst({
          where: {
            userId,
            phoneNumber: contact.phone,
          },
        });
      }
      
      if (existingPerson) {
        // Update existing person with new info if fields are empty
        const updateData: Record<string, any> = {};
        
        if (!existingPerson.firstName && contact.firstName) {
          updateData.firstName = contact.firstName;
        }
        if (!existingPerson.lastName && contact.lastName) {
          updateData.lastName = contact.lastName;
        }
        if (!existingPerson.company && contact.company) {
          updateData.company = contact.company;
        }
        if (!existingPerson.title && contact.title) {
          updateData.title = contact.title;
        }
        if (!existingPerson.phoneNumber && contact.phone) {
          updateData.phoneNumber = contact.phone;
        }
        
        // Merge email addresses
        const existingEmails = (existingPerson.emailAddresses as string[]) || [];
        const newEmails = [...new Set([...existingEmails, ...contact.emails])];
        if (newEmails.length > existingEmails.length) {
          updateData.emailAddresses = newEmails;
        }
        
        if (Object.keys(updateData).length > 0) {
          await prisma.person.update({
            where: { id: existingPerson.id },
            data: updateData,
          });
          updated++;
        } else {
          skipped++;
        }
      } else {
        // Create new person
        await prisma.person.create({
          data: {
            userId,
            firstName: contact.firstName || '',
            lastName: contact.lastName || '',
            email: contact.email,
            emailAddresses: contact.emails,
            phoneNumber: contact.phone,
            company: contact.company,
            title: contact.title,
          },
        });
        created++;
      }
    } catch (error) {
      console.error(`Error importing contact ${contact.fullName}:`, error);
      skipped++;
    }
  }
  
  return { created, updated, skipped };
}

