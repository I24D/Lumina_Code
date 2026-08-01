"# Phone Link Extension

Windows Phone Link (Enlace Móvil) automation for WhatsApp and SMS notifications.

## Features

- 🚀 **Fast WhatsApp responses** (2-3 seconds vs 8-14 seconds with generic UI automation)
- 🎯 **Fuzzy contact matching** (finds "Sandra" → "Sandra Patricia")
- ✅ **Automatic verification** (confirms message was sent via OCR)
- 🔄 **Smart retries** (fallback from UIA to vision-based interaction)
- 💾 **Window caching** (remembers Phone Link hwnd/pid between calls)

## Commands

### `/whatsapp_respond`

Respond to a WhatsApp contact via Windows Phone Link.

**Usage:**
```
/whatsapp_respond <contact> <message>
```

**Parameters:**
- `contact` - Contact name (supports fuzzy match)
- `message` - Message to send (max 4096 characters)
- `fuzzyMatch` - Enable fuzzy matching (default: true)

**Examples:**
```
/whatsapp_respond Abuela Lunita Hola, ¿cómo estás? Te mando un abrazo grande.
/whatsapp_respond Sandra Patricia Aquí estoy
/whatsapp_respond Mamá Ya llegué, todo bien
```

### `/phone_link_status`

Check if Phone Link (Enlace Móvil) is connected.

**Usage:**
```
/phone_link_status
```

**Output:**
- 🟢 Enlace Móvil: Conectado
- 🔴 Enlace Móvil: Desconectado
- 🟡 Enlace Móvil: Estado desconocido

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Phone Link Extension                      │
├─────────────────────────────────────────────────────────────┤
│  whatsapp_respond command                                    │
│  ├─ 1. Focus/Open Phone Link (PhoneExperienceHost.exe)      │
│  ├─ 2. Find contact (vision_click + UIA fallback)           │
│  ├─ 3. Wait for chat panel                                  │
│  ├─ 4. Type message (ReplyTextBox)                          │
│  ├─ 5. Send (Enter key)                                     │
│  └─ 6. Verify (OCR check for "You" or message text)         │
├─────────────────────────────────────────────────────────────┤
│  phone_link_status command                                   │
│  ├─ 1. List windows                                         │
│  ├─ 2. Find PhoneExperienceHost.exe                         │
│  └─ 3. OCR check for "Conectado"                            │
└─────────────────────────────────────────────────────────────┘
```

## Dependencies

- Windows 10/11 with Phone Link app installed
- Android phone paired via Phone Link
- Lumina Windows Bridge enabled
- WhatsApp connected in Phone Link

## Performance

| Metric | Generic UI Automation | Phone Link Extension |
|--------|----------------------|---------------------|
| Response time | 8-14 seconds | 2-3 seconds |
| Success rate | ~70% | ~95% |
| Tool calls | 6-10 | 4-6 |
| Screenshots | 3-5 | 2 |

## Troubleshooting

### "No se encontró el contacto"
- Ensure contact name matches exactly (or enable fuzzyMatch)
- Check if WhatsApp is connected in Phone Link
- Try scrolling the conversation list first

### "No se pudo abrir Enlace Móvil"
- Verify Phone Link app is installed
- Check Windows permissions for Phone Link
- Ensure phone is connected via Bluetooth/WiFi

### "No se encontró el campo para escribir mensaje"
- Wait for chat panel to fully load
- Try clicking the contact again
- Check if the conversation is archived

## Development

```bash
# Build
cd extensions/phone-link
npm run build

# Test
npm run test
```

## License

MIT