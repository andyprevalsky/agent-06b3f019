import { useState, useEffect } from 'react';
import { getPeople, Person, PeoplePaginatedResponse } from '@/lib/api';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function NetworkView() {
  const [data, setData] = useState<PeoplePaginatedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);

  const fetchPeople = async (page: number) => {
    try {
      setLoading(true);
      setError(null);
      const response = await getPeople(page, 50);
      setData(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load network');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPeople(currentPage);
  }, [currentPage]);

  const handlePrevPage = () => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1);
    }
  };

  const handleNextPage = () => {
    if (data && currentPage < data.pagination.totalPages) {
      setCurrentPage(currentPage + 1);
    }
  };

  const formatValue = (value: any): string => {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'number') {
      return value.toLocaleString();
    }
    if (typeof value === 'string' && value.length === 0) return '—';
    return String(value);
  };

  const formatCurrency = (value: number | null | undefined): string => {
    if (value === null || value === undefined) return '—';
    return `$${value.toLocaleString()}`;
  };

  const formatDate = (dateString: string): string => {
    return new Date(dateString).toLocaleDateString();
  };

  const hasData = data && data.people.length > 0;
  const showEmptyState = !loading && (!data || data.people.length === 0);

  return (
    <div className="h-full overflow-y-auto pt-20">
      <div className="container max-w-7xl mx-auto py-12 px-4">
        <div className="mb-8 backdrop-blur-md bg-background/80 p-6 rounded-xl border border-border/50 dark:border-navi-light-light-black/50">
          <h1 className="text-4xl font-bold mb-2">Network</h1>
          <p className="text-muted-foreground">
            Your personal and professional connections
          </p>
        </div>

        <div className="backdrop-blur-[12px] shadow-lg border border-border/50 dark:border-navi-light-light-black/50 rounded-xl overflow-hidden flex flex-col" style={{ height: 'calc(100vh - 280px)' }}>
          {/* Header with pagination */}
          <div className="flex items-center justify-between p-4 border-b border-border/50 dark:border-navi-light-light-black/50">
            <h2 className="text-lg font-semibold">Contacts</h2>
            <div className="flex items-center gap-4">
              {data && (
                <span className="text-sm text-muted-foreground">
                  {data.pagination.total.toLocaleString()} total
                </span>
              )}
              {data && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={handlePrevPage}
                    disabled={currentPage === 1}
                    className={cn(
                      'px-3 py-1 text-sm rounded border border-border/50 dark:border-navi-light-light-black/50',
                      currentPage === 1
                        ? 'opacity-50 cursor-not-allowed'
                        : 'hover:bg-white/10 dark:hover:bg-black/10 cursor-pointer'
                    )}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="text-sm text-muted-foreground">
                    Page {currentPage} of {data.pagination.totalPages}
                  </span>
                  <button
                    onClick={handleNextPage}
                    disabled={currentPage === data.pagination.totalPages}
                    className={cn(
                      'px-3 py-1 text-sm rounded border border-border/50 dark:border-navi-light-light-black/50',
                      currentPage === data.pagination.totalPages
                        ? 'opacity-50 cursor-not-allowed'
                        : 'hover:bg-white/10 dark:hover:bg-black/10 cursor-pointer'
                    )}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Fixed height scrollable table container */}
          <div className="flex-1 overflow-auto relative flex">
          <table className="w-full text-sm">
            <thead className="sticky top-0 backdrop-blur-md border-b border-border/50 dark:border-navi-light-light-black/50 z-10">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">First Name</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">Last Name</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">Messages</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">Email</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">Phone</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">Company</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">Title</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">Relation</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">Relationship Quality</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">Communication Freq</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">Location</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">Online Reach</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">Net Worth</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">Contact Status</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">Bandwidth</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">Network Orientation</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">Power Ranking</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">Age</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">Added</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr>
                  <td colSpan={19} className="px-4 py-12 text-center text-muted-foreground">
                    Loading network...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={19} className="px-4 py-12 text-center text-red-500">
                    Error: {error}
                  </td>
                </tr>
              ) : showEmptyState ? (
                <tr>
                  <td colSpan={19} className="px-4 py-12 text-center">
                    <div className="space-y-2">
                      <p className="text-muted-foreground">No people in your network yet</p>
                      <p className="text-sm text-muted-foreground/70">
                        Connect your integrations to start building your network
                      </p>
                    </div>
                  </td>
                </tr>
              ) : hasData ? (
                data.people.map((person) => (
                <tr
                  key={person.id}
                  onClick={() => setSelectedPerson(person)}
                  className="border-b border-border/30 dark:border-navi-light-light-black/30 hover:bg-white/20 dark:hover:bg-black/20 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3 whitespace-nowrap">{person.firstName}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{person.lastName}</td>
                  <td className="px-4 py-3 whitespace-nowrap font-semibold">{person.messagesExchanged}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatValue(person.email)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatValue(person.phoneNumber)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatValue(person.company)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatValue(person.title)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatValue(person.relation)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatValue(person.relationshipQuality)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatValue(person.communicationFrequency)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatValue(person.location)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatValue(person.totalOnlineReach)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatCurrency(person.estimatedNetWorthUsd)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatValue(person.contactStatus)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatValue(person.currentBandwidth)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatValue(person.networkOrientation)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatValue(person.estimatedWorldPowerRanking)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatValue(person.age)}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{formatDate(person.createdAt)}</td>
                </tr>
              ))
              ) : null}
            </tbody>
          </table>

          {/* Detail drawer - slides in from right within the table container */}
          {selectedPerson && (
            <div className="w-96 border-l border-border/50 dark:border-navi-light-light-black/50 backdrop-blur-md flex flex-col">
              {/* Drawer header */}
              <div className="flex items-center justify-between p-4 border-b border-border/50 dark:border-navi-light-light-black/50">
            <h3 className="font-semibold">Contact Details</h3>
            <button
              onClick={() => setSelectedPerson(null)}
              className="p-1 rounded hover:bg-white/10 dark:hover:bg-black/10 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Drawer content */}
          <div className="flex-1 overflow-auto p-4 space-y-4">
            {/* Name section */}
            <div>
              <h4 className="text-lg font-semibold">
                {selectedPerson.firstName} {selectedPerson.lastName}
              </h4>
              {selectedPerson.title && selectedPerson.company && (
                <p className="text-sm text-muted-foreground">
                  {selectedPerson.title} at {selectedPerson.company}
                </p>
              )}
            </div>

            {/* Engagement */}
            <div className="space-y-2">
              <h5 className="text-sm font-semibold text-muted-foreground uppercase">Engagement</h5>
              <DetailRow label="Messages Exchanged" value={selectedPerson.messagesExchanged} />
              <DetailRow label="Communication Frequency" value={selectedPerson.communicationFrequency} />
              <DetailRow label="Relationship Quality" value={selectedPerson.relationshipQuality} />
            </div>

            {/* Contact Info */}
            <div className="space-y-2">
              <h5 className="text-sm font-semibold text-muted-foreground uppercase">Contact</h5>
              <DetailRow label="Email" value={selectedPerson.email} />
              <DetailRow label="Phone" value={selectedPerson.phoneNumber} />
              <DetailRow label="Location" value={selectedPerson.location} />
            </div>

            {/* Professional */}
            <div className="space-y-2">
              <h5 className="text-sm font-semibold text-muted-foreground uppercase">Professional</h5>
              <DetailRow label="Company" value={selectedPerson.company} />
              <DetailRow label="Title" value={selectedPerson.title} />
              <DetailRow label="Profession" value={selectedPerson.profession} />
              <DetailRow label="Industry" value={selectedPerson.industry} />
            </div>

            {/* Relationship */}
            <div className="space-y-2">
              <h5 className="text-sm font-semibold text-muted-foreground uppercase">Relationship</h5>
              <DetailRow label="Relation" value={selectedPerson.relation} />
              <DetailRow label="Contact Status" value={selectedPerson.contactStatus} />
              <DetailRow label="Current Bandwidth" value={selectedPerson.currentBandwidth} />
              <DetailRow label="Network Orientation" value={selectedPerson.networkOrientation} />
            </div>

            {/* Metrics */}
            <div className="space-y-2">
              <h5 className="text-sm font-semibold text-muted-foreground uppercase">Metrics</h5>
              <DetailRow label="Online Reach" value={selectedPerson.totalOnlineReach?.toLocaleString()} />
              <DetailRow 
                label="Estimated Net Worth" 
                value={selectedPerson.estimatedNetWorthUsd ? formatCurrency(selectedPerson.estimatedNetWorthUsd) : undefined} 
              />
              <DetailRow label="World Power Ranking" value={selectedPerson.estimatedWorldPowerRanking} />
            </div>

            {/* Personal */}
            <div className="space-y-2">
              <h5 className="text-sm font-semibold text-muted-foreground uppercase">Personal</h5>
              <DetailRow label="Age" value={selectedPerson.age} />
            </div>

            {/* Social Media */}
            {(selectedPerson.linkedinUrl || selectedPerson.twitterHandle || 
              selectedPerson.instagramHandle || selectedPerson.facebookUrl) && (
              <div className="space-y-2">
                <h5 className="text-sm font-semibold text-muted-foreground uppercase">Social Media</h5>
                {selectedPerson.linkedinUrl && (
                  <DetailRow 
                    label="LinkedIn" 
                    value={
                      <a 
                        href={selectedPerson.linkedinUrl} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-blue-500 hover:underline"
                      >
                        {selectedPerson.linkedinUrl}
                      </a>
                    } 
                  />
                )}
                {selectedPerson.twitterHandle && (
                  <DetailRow label="Twitter" value={`@${selectedPerson.twitterHandle}`} />
                )}
                {selectedPerson.instagramHandle && (
                  <DetailRow label="Instagram" value={`@${selectedPerson.instagramHandle}`} />
                )}
                {selectedPerson.facebookUrl && (
                  <DetailRow 
                    label="Facebook" 
                    value={
                      <a 
                        href={selectedPerson.facebookUrl} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-blue-500 hover:underline"
                      >
                        {selectedPerson.facebookUrl}
                      </a>
                    } 
                  />
                )}
              </div>
            )}

            {/* Notes */}
            {selectedPerson.notes && (
              <div className="space-y-2">
                <h5 className="text-sm font-semibold text-muted-foreground uppercase">Notes</h5>
                <p className="text-sm whitespace-pre-wrap">{selectedPerson.notes}</p>
              </div>
            )}

            {/* Metadata */}
            <div className="space-y-2 pt-4 border-t border-border/50 dark:border-navi-light-light-black/50">
              <DetailRow label="Added" value={formatDate(selectedPerson.createdAt)} />
              <DetailRow label="Last Updated" value={formatDate(selectedPerson.updatedAt)} />
            </div>
          </div>
        </div>
      )}
        </div>
      </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: any }) {
  const displayValue = value === null || value === undefined || value === '' ? '—' : value;
  
  return (
    <div className="flex justify-between items-start gap-4 text-sm">
      <span className="text-muted-foreground min-w-[140px]">{label}</span>
      <span className="text-right flex-1 break-words">{displayValue}</span>
    </div>
  );
}

