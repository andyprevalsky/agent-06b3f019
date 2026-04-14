"""Data access for the send-message-to-user domain.

This domain has no direct data access. All I/O is performed through
Temporal activities (get_agent_source, notify_sms_event_activity) which
are invoked at the handler layer via workflow.execute_activity.
"""
