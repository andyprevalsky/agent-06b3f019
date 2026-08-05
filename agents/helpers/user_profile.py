"""Canonical user-profile sections shared by main and browser agents."""

from typing import Any, Dict, List


def build_user_profile_sections(user_settings: Dict[str, Any]) -> List[str]:
    """Render personal identity and delivery details as separate sections."""
    sections: List[str] = []

    personal_lines = []
    if user_settings.get("name"):
        personal_lines.append(f"Full Name: {user_settings['name']}")
    if user_settings.get("phone"):
        personal_lines.append(f"Phone: {user_settings['phone']}")
    if user_settings.get("email"):
        personal_lines.append(f"Email: {user_settings['email']}")
    if personal_lines:
        sections.append("## Personal Information\n" + "\n".join(personal_lines))

    city_line = ", ".join(
        filter(
            None,
            [
                user_settings.get("city", ""),
                user_settings.get("state", ""),
                user_settings.get("postalCode", ""),
            ],
        )
    )
    address_values = [
        user_settings.get("addressLine1", ""),
        user_settings.get("addressLine2", ""),
        city_line,
        user_settings.get("country", ""),
    ]
    address_lines = []
    if user_settings.get("deliveryRecipientName"):
        address_lines.append(f"Recipient Name: {user_settings['deliveryRecipientName']}")
    address_lines.extend(line for line in address_values if isinstance(line, str) and line.strip())
    if address_lines:
        sections.append("## Delivery Address\n" + "\n".join(address_lines))

    return sections
