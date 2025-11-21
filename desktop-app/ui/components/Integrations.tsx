import { MessageSquare, Chrome, Loader2 } from 'lucide-react';
import { useState, useEffect } from 'react';

export function Integrations() {
  const [uploading, setUploading] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  
  // Listen for progress events
  useEffect(() => {
    window.api.onProgress((p) => setProgress(p.percent));
  }, []);
  
  const handleUploadIMessage = async () => {
    setUploading('imessage');
    setError(null);
    
    try {
      const hasAccess = await window.api.checkIMessageAccess();
      if (!hasAccess) {
        setError('Grant Full Disk Access in System Preferences → Privacy & Security → Full Disk Access');
        setUploading(null);
        return;
      }
      
      const messages = await window.api.readIMessages();
      const result = await window.api.uploadIMessages(messages);
      
      if (!result.success) {
        setError(result.message || 'Upload failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setUploading(null);
      setProgress(0);
    }
  };
  
  const handleUploadCookies = async () => {
    setUploading('cookies');
    setError(null);
    
    try {
      const cookies = await window.api.readChromeCookies();
      const result = await window.api.uploadCookies(cookies);
      
      if (!result.success) {
        setError(result.message || 'Upload failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setUploading(null);
      setProgress(0);
    }
  };
  
  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-4xl font-bold mb-2">Integrations</h1>
        <p className="text-muted-foreground mb-8">
          Upload your data sources to enhance Navi's knowledge
        </p>
        
        {error && (
          <div className="mb-6 p-4 bg-destructive/10 border border-destructive rounded-lg text-destructive text-sm">
            {error}
          </div>
        )}
        
        <div className="bg-[#EEEFF2]/80 dark:bg-[#1a1a1a]/80 backdrop-blur-[12px] border border-border rounded-lg">
          <div className="p-6 border-b border-border">
            <h2 className="text-xl font-semibold">Data Sources</h2>
            <p className="text-sm text-muted-foreground mt-1">Import your communication history</p>
          </div>
          <div className="p-6 space-y-3">
            {/* iMessage */}
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div className="flex items-center gap-3">
                <MessageSquare className="h-5 w-5" />
                <div>
                  <h3 className="font-medium">iMessage</h3>
                  <p className="text-sm text-muted-foreground">
                    Import your iMessage conversation history
                  </p>
                </div>
              </div>
              <button 
                onClick={handleUploadIMessage}
                disabled={uploading !== null}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {uploading === 'imessage' ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {progress}%
                  </span>
                ) : 'Upload'}
              </button>
            </div>
            
            {/* Chrome Cookies */}
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div className="flex items-center gap-3">
                <Chrome className="h-5 w-5" />
                <div>
                  <h3 className="font-medium">Chrome Cookies</h3>
                  <p className="text-sm text-muted-foreground">
                    Import your Chrome browser cookies
                  </p>
                </div>
              </div>
              <button 
                onClick={handleUploadCookies}
                disabled={uploading !== null}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {uploading === 'cookies' ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {progress}%
                  </span>
                ) : 'Upload'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


