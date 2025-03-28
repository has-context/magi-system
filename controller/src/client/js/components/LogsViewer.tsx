import * as React from 'react';
import { useState, useEffect } from 'react';

interface LogsViewerProps {
    processId: string;
    onClose: () => void;
}

interface LogTab {
    id: string;
    name: string;
    component: React.ReactNode;
}

interface LogFile {
    timestamp: string;
    provider: string;
    request: any;
}

const LogsViewer: React.FC<LogsViewerProps> = ({ processId, onClose }) => {
    const [activeTab, setActiveTab] = useState<string>('llm');
    const [llmLogs, setLlmLogs] = useState<string[]>([]);
    const [dockerLogs, setDockerLogs] = useState<string[]>([]);
    const [costData, setCostData] = useState<any>(null);
    const [selectedLogFile, setSelectedLogFile] = useState<LogFile | null>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);

    // Fetch LLM logs when the component mounts
    useEffect(() => {
        const fetchLlmLogs = async () => {
            try {
                setLoading(true);
                const response = await fetch(`/api/llm-logs/${processId}`);
                if (!response.ok) {
                    throw new Error(`Failed to fetch LLM logs: ${response.statusText}`);
                }
                const data = await response.json();
                setLlmLogs(data.logFiles || []);
                setLoading(false);
            } catch (err) {
                console.error('Error fetching LLM logs:', err);
                setError('Failed to fetch LLM logs');
                setLoading(false);
            }
        };

        fetchLlmLogs();
    }, [processId]);

    // Fetch Docker logs when Docker tab is activated
    useEffect(() => {
        if (activeTab === 'docker') {
            const fetchDockerLogs = async () => {
                try {
                    setLoading(true);
                    const response = await fetch(`/api/docker-logs/${processId}`);
                    if (!response.ok) {
                        throw new Error(`Failed to fetch Docker logs: ${response.statusText}`);
                    }
                    const data = await response.json();
                    setDockerLogs(data.logs || []);
                    setLoading(false);
                } catch (err) {
                    console.error('Error fetching Docker logs:', err);
                    setError('Failed to fetch Docker logs');
                    setLoading(false);
                }
            };

            fetchDockerLogs();
        }
    }, [activeTab, processId]);

    // Fetch cost data when Cost tab is activated
    useEffect(() => {
        if (activeTab === 'cost') {
            const fetchCostData = async () => {
                try {
                    setLoading(true);
                    const response = await fetch(`/api/cost-tracker/${processId}`);
                    if (!response.ok) {
                        throw new Error(`Failed to fetch cost data: ${response.statusText}`);
                    }
                    const data = await response.json();
                    setCostData(data);
                    setLoading(false);
                } catch (err) {
                    console.error('Error fetching cost data:', err);
                    setError('Failed to fetch cost data');
                    setLoading(false);
                }
            };

            fetchCostData();
        }
    }, [activeTab, processId]);

    // Handle log file selection
    const handleLogFileSelect = async (fileName: string) => {
        try {
            setLoading(true);
            const response = await fetch(`/api/llm-logs/${processId}/${fileName}`);
            if (!response.ok) {
                throw new Error(`Failed to fetch log file: ${response.statusText}`);
            }
            const data = await response.json();
            setSelectedLogFile(data);
            setLoading(false);
        } catch (err) {
            console.error('Error fetching log file:', err);
            setError('Failed to fetch log file');
            setLoading(false);
        }
    };

    // Format log filename for display
    const formatLogFileName = (fileName: string) => {
        try {
            // Extract timestamp and provider from filename format: YYYY-MM-DDTHH-mm-ss-mmm_provider.json
            const parts = fileName.split('_');
            if (parts.length >= 2) {
                const timestampPart = parts[0].replace(/-/g, ':').replace('T', ' ');
                const providerPart = parts[1].replace('.json', '');
                return `${timestampPart} - ${providerPart}`;
            }
            return fileName;
        } catch (e) {
            return fileName;
        }
    };

    // Render LLM logs tab content
    const renderLlmLogsTab = () => {
        if (loading) {
            return <div className="text-center p-4">Loading logs...</div>;
        }

        if (error) {
            return <div className="text-center p-4 text-danger">{error}</div>;
        }

        if (llmLogs.length === 0) {
            return <div className="text-center p-4">No LLM logs found</div>;
        }

        return (
            <div className="row h-100">
                <div className="col-md-3 border-end" style={{maxHeight: '100%', overflowY: 'auto'}}>
                    <h5 className="mt-3 mb-3">Log Files</h5>
                    <div className="list-group">
                        {llmLogs.map((log, index) => (
                            <button
                                key={index}
                                className={`list-group-item list-group-item-action ${selectedLogFile && formatLogFileName(log) === formatLogFileName(selectedLogFile.timestamp) ? 'active' : ''}`}
                                onClick={() => handleLogFileSelect(log)}
                            >
                                {formatLogFileName(log)}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="col-md-9" style={{maxHeight: '100%', overflowY: 'auto'}}>
                    {selectedLogFile ? (
                        <div className="p-3">
                            <h5 className="mb-3">Request Details</h5>
                            <div className="mb-3">
                                <strong>Timestamp:</strong> {selectedLogFile.timestamp}
                            </div>
                            <div className="mb-3">
                                <strong>Provider:</strong> {selectedLogFile.provider}
                            </div>
                            <div className="mb-3">
                                <strong>Request:</strong>
                                <pre className="bg-light p-3 mt-2 rounded" style={{maxHeight: '500px', overflowY: 'auto', whiteSpace: 'pre-wrap'}}>
                                    {JSON.stringify(selectedLogFile.request, null, 2)}
                                </pre>
                            </div>
                        </div>
                    ) : (
                        <div className="text-center p-4">Select a log file to view details</div>
                    )}
                </div>
            </div>
        );
    };

    // Render Docker logs tab content
    const renderDockerLogsTab = () => {
        if (loading) {
            return <div className="text-center p-4">Loading Docker logs...</div>;
        }

        if (error) {
            return <div className="text-center p-4 text-danger">{error}</div>;
        }

        if (dockerLogs.length === 0) {
            return <div className="text-center p-4">No Docker logs found</div>;
        }

        return (
            <div className="p-3">
                <pre className="bg-light p-3 rounded" style={{maxHeight: '600px', overflowY: 'auto'}}>
                    {dockerLogs.join('\n')}
                </pre>
            </div>
        );
    };

    // Render cost data tab content
    const renderCostTab = () => {
        if (loading) {
            return <div className="text-center p-4">Loading cost data...</div>;
        }

        if (error) {
            return <div className="text-center p-4 text-danger">{error}</div>;
        }

        if (!costData) {
            return <div className="text-center p-4">No cost data available</div>;
        }

        return (
            <div className="p-4">
                <div className="card mb-4">
                    <div className="card-header bg-primary text-white">
                        <h5 className="mb-0">Total Cost</h5>
                    </div>
                    <div className="card-body">
                        <h2 className="text-center">${parseFloat(costData.total).toFixed(6)}</h2>
                    </div>
                </div>

                <h5 className="mb-3">Costs by Model</h5>
                {Object.entries(costData.byModel).length === 0 ? (
                    <p>No model usage data available</p>
                ) : (
                    <div className="table-responsive">
                        <table className="table table-striped">
                            <thead>
                                <tr>
                                    <th>Model</th>
                                    <th>Calls</th>
                                    <th>Cost</th>
                                </tr>
                            </thead>
                            <tbody>
                                {Object.entries(costData.byModel).map(([model, data]: [string, any]) => (
                                    <tr key={model}>
                                        <td>{model}</td>
                                        <td>{data.calls}</td>
                                        <td>${parseFloat(data.cost).toFixed(6)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        );
    };

    // Define tabs
    const tabs: LogTab[] = [
        {
            id: 'llm',
            name: 'LLM Logs',
            component: renderLlmLogsTab()
        },
        {
            id: 'docker',
            name: 'Docker Logs',
            component: renderDockerLogsTab()
        },
        {
            id: 'cost',
            name: 'Cost Tracker',
            component: renderCostTab()
        }
    ];

    return (
        <div className="logs-viewer position-fixed start-0 top-0 end-0 bottom-0 bg-white" style={{zIndex: 1050}}>
            <div className="container-fluid h-100 d-flex flex-column">
                <div className="row border-bottom py-3 align-items-center">
                    <div className="col">
                        <h3 className="mb-0">Process Logs - {processId}</h3>
                    </div>
                    <div className="col-auto">
                        <button className="btn btn-outline-secondary" onClick={onClose}>
                            Close
                        </button>
                    </div>
                </div>

                <div className="row mt-3">
                    <div className="col">
                        <ul className="nav nav-tabs">
                            {tabs.map(tab => (
                                <li className="nav-item" key={tab.id}>
                                    <button
                                        className={`nav-link ${activeTab === tab.id ? 'active' : ''}`}
                                        onClick={() => setActiveTab(tab.id)}
                                    >
                                        {tab.name}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>

                <div className="row flex-grow-1 overflow-hidden mt-3">
                    <div className="col h-100 overflow-auto">
                        {tabs.find(tab => tab.id === activeTab)?.component}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default LogsViewer;
