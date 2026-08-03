import os
import tempfile
import unittest

from sidecars.whatsapp import (
    choose_attachment_label,
    conversation_from_labels,
    is_time_or_date,
    normalize,
    render_text_status,
    score_contact,
    validate_media_path,
)


class WhatsAppAdapterTests(unittest.TestCase):
    def test_normalize_removes_accents_and_extra_space(self):
        self.assertEqual(normalize("  Jos\u00e9   Mu\u00f1oz "), "jose munoz")

    def test_contact_score_prefers_exact_and_rejects_partial_token_sets(self):
        self.assertEqual(score_contact("sandra", "sandra", ["sandra"]), 1.0)
        self.assertGreater(
            score_contact("sandra patricia", "sandra", ["sandra"]),
            0.8,
        )
        self.assertEqual(
            score_contact("sandra patricia", "patricia otra", ["patricia", "otra"]),
            0.0,
        )

    def test_conversation_metadata_uses_structured_labels(self):
        result = conversation_from_labels(
            "2 unread messages Sandra Patricia 10:13 AM Hola",
            ["Sandra Patricia", "10:13 AM"],
            ["Sandra Patricia", "10:13 AM", "Hola"],
        )
        self.assertEqual(result["name"], "Sandra Patricia")
        self.assertEqual(result["timestamp"], "10:13 AM")
        self.assertEqual(result["preview"], "Hola")
        self.assertEqual(result["unreadCount"], 2)

    def test_status_flag_and_date_labels(self):
        result = conversation_from_labels(
            "View status Sandra Yesterday Hola",
            ["Sandra", "Yesterday"],
            ["View status", "Sandra", "Yesterday", "Hola"],
        )
        self.assertTrue(result["hasStatus"])
        self.assertTrue(is_time_or_date("Yesterday"))
        self.assertTrue(is_time_or_date("8:15 AM"))

    def test_attachment_types(self):
        self.assertIn("photos & videos", choose_attachment_label("photo.jpg"))
        self.assertIn("audio", choose_attachment_label("voice.mp3"))
        self.assertIn("document", choose_attachment_label("report.pdf"))

    def test_media_validation_and_background_rejection(self):
        with tempfile.NamedTemporaryFile(suffix=".jpg") as handle:
            self.assertEqual(
                validate_media_path(handle.name, {".jpg"}),
                os.path.abspath(handle.name),
            )
        with self.assertRaisesRegex(ValueError, "invalid_status_background"):
            render_text_status("Hola", "green")


if __name__ == "__main__":
    unittest.main()
