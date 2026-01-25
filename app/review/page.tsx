'use client';

import { useState, useEffect, useCallback } from 'react';
import { ToastContainer, useToast } from '../components/Toast';

interface ReviewItem {
  approvalId: string;
  issueId: string;
  workflowRunId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  proposedAction: 'enrich' | 'delete' | 'merge';
  confidence: number;
  problem: string;
  currentData: Record<string, unknown>;
  suggestedResolution: string;
  createdAt: string;
  position: number;
  total: number;
  remaining: number;
}

interface ReviewStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  byNodeType: Record<string, number>;
  byAction: Record<string, number>;
}

interface ApiResponse {
  item: ReviewItem | null;
  fullReasoning?: string;
  stats: ReviewStats;
  message?: string;
  filters?: {
    nodeType: string | null;
    action: string | null;
    skip: number;
  };
}

interface DecisionResponse {
  success: boolean;
  message: string;
  approvalId: string;
  decision: string;
  actionResult?: {
    success: boolean;
    message: string;
  };
  stats: ReviewStats;
}

export default function ReviewPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notes, setNotes] = useState('');
  const [showReasoning, setShowReasoning] = useState(false);
  const [actionFilter, setActionFilter] = useState<string>('');
  const [nodeTypeFilter, setNodeTypeFilter] = useState<string>('');

  const toast = useToast();

  const fetchItem = useCallback(async (clearFirst = false) => {
    if (clearFirst) {
      setData(null); // Clear current item to force visual update
    }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (actionFilter) params.set('action', actionFilter);
      if (nodeTypeFilter) params.set('nodeType', nodeTypeFilter);
      // Add cache-buster to prevent stale data
      params.set('_t', Date.now().toString());

      const response = await fetch(`/api/approvals/review?${params}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      });
      const result: ApiResponse = await response.json();

      // Ensure stats have valid numbers
      if (result.stats) {
        result.stats.total = result.stats.total ?? 0;
        result.stats.pending = result.stats.pending ?? 0;
        result.stats.approved = result.stats.approved ?? 0;
        result.stats.rejected = result.stats.rejected ?? 0;
      }

      setData(result);

      if (!result.item && result.stats?.pending === 0) {
        toast.success('Alle Items überprüft!', ['Keine weiteren Approvals ausstehend']);
      }
    } catch (error) {
      toast.error('Fehler beim Laden', [
        error instanceof Error ? error.message : 'Unbekannter Fehler'
      ]);
      // Set empty stats on error
      setData({
        item: null,
        stats: { total: 0, pending: 0, approved: 0, rejected: 0, byNodeType: {}, byAction: {} },
        message: 'Fehler beim Laden der Daten',
      });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionFilter, nodeTypeFilter]);

  useEffect(() => {
    fetchItem();
  }, [fetchItem]);

  const handleDecision = async (decision: 'approve' | 'reject' | 'skip' | 'delete') => {
    if (!data?.item) return;

    setSubmitting(true);
    const startTime = Date.now();

    try {
      const response = await fetch('/api/approvals/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvalId: data.item.approvalId,
          decision,
          notes: notes || undefined,
        }),
      });

      const result: DecisionResponse = await response.json();
      const duration = Date.now() - startTime;

      if (result.success) {
        const details: string[] = [];

        // Add action-specific details
        if (decision === 'approve') {
          details.push(`Aktion: ${data.item.proposedAction}`);
          if (result.actionResult) {
            details.push(result.actionResult.message);
          }
        } else if (decision === 'reject') {
          details.push('Correction Rule erstellt');
          if (notes) details.push(`Grund: ${notes}`);
        } else if (decision === 'delete') {
          details.push('Node aus Graph gelöscht');
          if (result.actionResult) {
            details.push(result.actionResult.message);
          }
        }

        // Add timing info
        details.push(`Ausgeführt in ${duration}ms`);

        // Add remaining count
        if (result.stats) {
          details.push(`Verbleibend: ${result.stats.pending} Items`);
        }

        const toastType = decision === 'approve' ? 'success'
          : decision === 'delete' ? 'warning'
          : decision === 'reject' ? 'info'
          : 'info';

        toast[toastType](result.message, details);

        // Clear notes and fetch next item with visual clear
        setNotes('');
        await fetchItem(true); // Pass true to clear current item first
      } else {
        toast.error('Aktion fehlgeschlagen', [
          result.message,
          `Approval ID: ${data.item.approvalId}`
        ]);
      }
    } catch (error) {
      toast.error('Netzwerkfehler', [
        error instanceof Error ? error.message : 'Verbindung fehlgeschlagen'
      ]);
    } finally {
      setSubmitting(false);
    }
  };

  const actionColors = {
    enrich: 'bg-blue-100 text-blue-800 border-blue-200',
    delete: 'bg-red-100 text-red-800 border-red-200',
    merge: 'bg-purple-100 text-purple-800 border-purple-200',
  };

  const confidenceColor = (confidence: number) => {
    if (confidence >= 0.95) return 'text-green-600';
    if (confidence >= 0.90) return 'text-yellow-600';
    return 'text-orange-600';
  };

  return (
    <div className="max-w-4xl mx-auto p-6">
      <ToastContainer messages={toast.messages} onDismiss={toast.dismissToast} />

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Review Queue</h1>
        <p className="text-gray-500">Manuelle Überprüfung ausstehender Entscheidungen</p>
      </div>

      {/* Stats Bar */}
      {data?.stats && (
        <div className="mb-6 grid grid-cols-4 gap-4">
          <div className="bg-white rounded-lg shadow p-4 text-center">
            <div className="text-2xl font-bold text-orange-600">{data.stats.pending ?? 0}</div>
            <div className="text-sm text-gray-500">Ausstehend</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4 text-center">
            <div className="text-2xl font-bold text-green-600">{data.stats.approved ?? 0}</div>
            <div className="text-sm text-gray-500">Genehmigt</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4 text-center">
            <div className="text-2xl font-bold text-red-600">{data.stats.rejected ?? 0}</div>
            <div className="text-sm text-gray-500">Abgelehnt</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4 text-center">
            <div className="text-2xl font-bold text-gray-600">{data.stats.total ?? 0}</div>
            <div className="text-sm text-gray-500">Gesamt</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="mb-6 flex gap-4">
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="px-3 py-2 border rounded-lg text-sm bg-white"
        >
          <option value="">Alle Aktionen</option>
          <option value="enrich">Enrich</option>
          <option value="delete">Delete</option>
          <option value="merge">Merge</option>
        </select>
        <select
          value={nodeTypeFilter}
          onChange={(e) => setNodeTypeFilter(e.target.value)}
          className="px-3 py-2 border rounded-lg text-sm bg-white"
        >
          <option value="">Alle Node-Typen</option>
          {data?.stats?.byNodeType && Object.keys(data.stats.byNodeType).map((type) => (
            <option key={type} value={type}>
              {type} ({data.stats.byNodeType[type]})
            </option>
          ))}
        </select>
      </div>

      {/* Loading State */}
      {loading && (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600 mx-auto mb-4"></div>
          <p className="text-gray-500">Lade nächstes Item...</p>
        </div>
      )}

      {/* No Items */}
      {!loading && !data?.item && (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <div className="text-4xl mb-4">🎉</div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            {data?.message ?? 'Keine Items zum Überprüfen'}
          </h2>
          <p className="text-gray-500">
            Alle ausstehenden Approvals wurden bearbeitet.
          </p>
        </div>
      )}

      {/* Review Item */}
      {!loading && data?.item && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          {/* Item Header */}
          <div className="border-b bg-gray-50 px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className={`px-3 py-1 rounded-full text-sm font-medium border ${actionColors[data.item.proposedAction]}`}>
                  {data.item.proposedAction.toUpperCase()}
                </span>
                <span className="text-gray-400">|</span>
                <span className="text-sm text-gray-600">{data.item.nodeType}</span>
              </div>
              <div className="text-sm text-gray-500">
                {data.item.position} von {data.item.total}
              </div>
            </div>
          </div>

          {/* Item Content */}
          <div className="p-6">
            {/* Node Name */}
            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              {data.item.nodeName}
            </h2>

            {/* Confidence */}
            <div className="mb-4">
              <span className="text-sm text-gray-500">Confidence: </span>
              <span className={`font-semibold ${confidenceColor(data.item.confidence)}`}>
                {(data.item.confidence * 100).toFixed(1)}%
              </span>
            </div>

            {/* Problem */}
            <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <h3 className="font-medium text-yellow-800 mb-1">Problem</h3>
              <p className="text-yellow-700">{data.item.problem}</p>
            </div>

            {/* Suggested Resolution */}
            <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <h3 className="font-medium text-blue-800 mb-1">Vorgeschlagene Lösung</h3>
              <p className="text-blue-700">{data.item.suggestedResolution}</p>
            </div>

            {/* Current Data */}
            <div className="mb-4">
              <h3 className="font-medium text-gray-700 mb-2">Aktuelle Daten</h3>
              <div className="bg-gray-50 rounded-lg p-4 overflow-x-auto">
                <pre className="text-sm text-gray-600">
                  {JSON.stringify(data.item.currentData, null, 2)}
                </pre>
              </div>
            </div>

            {/* Full Reasoning Toggle */}
            {data.fullReasoning && (
              <div className="mb-4">
                <button
                  onClick={() => setShowReasoning(!showReasoning)}
                  className="text-sm text-blue-600 hover:text-blue-800"
                >
                  {showReasoning ? '▼ Reasoning verbergen' : '▶ Vollständiges Reasoning anzeigen'}
                </button>
                {showReasoning && (
                  <div className="mt-2 p-4 bg-gray-50 rounded-lg">
                    <pre className="text-sm text-gray-600 whitespace-pre-wrap">
                      {data.fullReasoning}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* Notes */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Notizen (optional)
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Begründung für die Entscheidung..."
                className="w-full px-3 py-2 border rounded-lg text-sm resize-none"
                rows={2}
              />
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3">
              <button
                onClick={() => handleDecision('approve')}
                disabled={submitting}
                className="flex-1 px-4 py-3 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {submitting ? '...' : '✓ Accept'}
              </button>
              <button
                onClick={() => handleDecision('reject')}
                disabled={submitting}
                className="flex-1 px-4 py-3 bg-gray-600 text-white rounded-lg font-medium hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {submitting ? '...' : '✗ Reject'}
              </button>
              <button
                onClick={() => handleDecision('skip')}
                disabled={submitting}
                className="px-4 py-3 bg-gray-200 text-gray-700 rounded-lg font-medium hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Skip
              </button>
              <button
                onClick={() => handleDecision('delete')}
                disabled={submitting}
                className="px-4 py-3 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                🗑️ Delete
              </button>
            </div>
          </div>

          {/* Item Footer */}
          <div className="border-t bg-gray-50 px-6 py-3 text-xs text-gray-500">
            <span>Approval ID: {data.item.approvalId}</span>
            <span className="mx-2">|</span>
            <span>Erstellt: {new Date(data.item.createdAt).toLocaleString()}</span>
          </div>
        </div>
      )}
    </div>
  );
}
