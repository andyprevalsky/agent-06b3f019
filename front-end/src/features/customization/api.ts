import { supabase, getSession } from '@/lib/supabase';

/** Uploads a profile picture to Supabase Storage. Returns the public URL with cache buster. */
export async function uploadProfilePicture(file: File): Promise<string> {
  const session = getSession();
  if (!session?.user?.id) {
    throw new Error('Not authenticated');
  }

  const userId = session.user.id;
  const fileExt = file.name.split('.').pop() || 'png';
  const filePath = `profile-pictures/${userId}/avatar.${fileExt}`;

  const { error: uploadError } = await supabase.storage.from('public').upload(filePath, file, {
    upsert: true,
    contentType: file.type,
  });

  if (uploadError) {
    throw uploadError;
  }

  const { data: urlData } = supabase.storage.from('public').getPublicUrl(filePath);
  return `${urlData.publicUrl}?t=${Date.now()}`;
}
