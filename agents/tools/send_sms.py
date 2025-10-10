"""SMS tool for sending and receiving text messages."""

import asyncio
from typing import Dict, List, Optional
from datetime import datetime, timedelta
from temporalio import activity
from twilio.rest import Client
from twilio.base.exceptions import TwilioRestException
import structlog

from config import load_config

logger = structlog.get_logger()


class SMSManager:
    """Manager for SMS operations using Twilio."""
    
    def __init__(self):
        config = load_config()
        self.client = Client(
            config.twilio.account_sid,
            config.twilio.auth_token
        )
        self.from_number = config.twilio.phone_number
        self._pending_responses: Dict[str, Dict] = {}
    
    async def send_message(
        self,
        to: str,
        body: str,
        expect_response: bool = False,
        timeout_seconds: int = 300
    ) -> Dict:
        """
        Send an SMS message.
        
        Args:
            to: Recipient phone number (E.164 format: +1234567890)
            body: Message body
            expect_response: Whether to wait for a response
            timeout_seconds: How long to wait for response
            
        Returns:
            Dict with message_sid, status, and optional response
        """
        try:
            activity.heartbeat(f"Sending SMS to {to}")
            
            message = await asyncio.to_thread(
                self.client.messages.create,
                body=body,
                from_=self.from_number,
                to=to
            )
            
            result = {
                "message_sid": message.sid,
                "status": message.status,
                "to": to,
                "body": body,
                "sent_at": datetime.utcnow().isoformat()
            }
            
            logger.info("SMS sent", **result)
            
            if expect_response:
                # Register for response tracking
                self._pending_responses[message.sid] = {
                    "to": to,
                    "sent_at": datetime.utcnow(),
                    "timeout": timedelta(seconds=timeout_seconds)
                }
                
                # Poll for response
                response = await self._wait_for_response(message.sid, timeout_seconds)
                result["response"] = response
            
            return result
            
        except TwilioRestException as e:
            logger.error("Twilio error", error=str(e), code=e.code)
            raise
        except Exception as e:
            logger.error("SMS send failed", error=str(e))
            raise
    
    async def _wait_for_response(
        self,
        original_sid: str,
        timeout_seconds: int
    ) -> Optional[Dict]:
        """
        Wait for an SMS response.
        
        This polls Twilio for incoming messages from the recipient.
        In production, you'd use webhooks instead.
        """
        start_time = datetime.utcnow()
        pending = self._pending_responses.get(original_sid)
        
        if not pending:
            return None
        
        to_number = pending["to"]
        
        while (datetime.utcnow() - start_time).total_seconds() < timeout_seconds:
            activity.heartbeat(f"Waiting for SMS response from {to_number}")
            
            # Check for incoming messages from this number
            messages = await asyncio.to_thread(
                self.client.messages.list,
                to=self.from_number,
                from_=to_number,
                date_sent_after=pending["sent_at"],
                limit=10
            )
            
            if messages:
                # Got a response!
                msg = messages[0]
                response = {
                    "message_sid": msg.sid,
                    "from": msg.from_,
                    "body": msg.body,
                    "received_at": msg.date_sent.isoformat() if msg.date_sent else None
                }
                
                logger.info("SMS response received", **response)
                del self._pending_responses[original_sid]
                return response
            
            # Wait before next poll
            await asyncio.sleep(5)
        
        # Timeout
        del self._pending_responses[original_sid]
        logger.warning("SMS response timeout", original_sid=original_sid)
        return None
    
    async def get_contacts(self) -> List[Dict]:
        """
        Get list of contacts (recent message history).
        
        Returns list of unique phone numbers and last interaction.
        """
        try:
            activity.heartbeat("Fetching contact list")
            
            # Get recent messages
            messages = await asyncio.to_thread(
                self.client.messages.list,
                limit=100
            )
            
            # Build contact list
            contacts = {}
            for msg in messages:
                # Determine if incoming or outgoing
                if msg.from_ == self.from_number:
                    # Outgoing message
                    phone = msg.to
                    direction = "outgoing"
                else:
                    # Incoming message
                    phone = msg.from_
                    direction = "incoming"
                
                if phone not in contacts:
                    contacts[phone] = {
                        "phone": phone,
                        "last_message": msg.body,
                        "last_interaction": msg.date_sent.isoformat() if msg.date_sent else None,
                        "direction": direction,
                        "message_count": 1
                    }
                else:
                    contacts[phone]["message_count"] += 1
            
            contact_list = sorted(
                contacts.values(),
                key=lambda x: x["last_interaction"] or "",
                reverse=True
            )
            
            logger.info("Contact list fetched", count=len(contact_list))
            return contact_list
            
        except Exception as e:
            logger.error("Failed to fetch contacts", error=str(e))
            raise


# Singleton instance
_sms_manager: Optional[SMSManager] = None


def get_sms_manager() -> SMSManager:
    """Get or create SMS manager singleton."""
    global _sms_manager
    if _sms_manager is None:
        _sms_manager = SMSManager()
    return _sms_manager


@activity.defn
async def send_sms(
    to: str,
    body: str,
    expect_response: bool = False,
    timeout_seconds: int = 300
) -> Dict:
    """
    Activity: Send an SMS message.
    
    Args:
        to: Recipient phone number (E.164 format)
        body: Message body
        expect_response: Whether to wait for a response
        timeout_seconds: Response timeout in seconds
        
    Returns:
        Dict with message details and optional response
    """
    manager = get_sms_manager()
    return await manager.send_message(to, body, expect_response, timeout_seconds)


@activity.defn
async def list_contacts() -> List[Dict]:
    """
    Activity: List available contacts from message history.
    
    Returns:
        List of contacts with phone numbers and last interaction
    """
    manager = get_sms_manager()
    return await manager.get_contacts()

