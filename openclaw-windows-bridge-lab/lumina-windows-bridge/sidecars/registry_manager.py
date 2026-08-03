"""
registry_manager.py — Windows Registry adapter for Lumina (§5), safety-first.

Reads are free. Writes/deletes are gated: a hard denylist blocks the boot /
security / policy hives that can brick Windows or escalate privilege, and every
mutating call requires an explicit confirm=true. This keeps the registry usable
for app settings (themes, per-app prefs) without handing the agent a foot-gun.

Uses the stdlib `winreg` (no external dep). Protocol (one JSON per stdout):
  python registry_manager.py --action <action> --json '<params>'
Actions:
  get     {hive, path, name?}            → value (or all values when name omitted)
  list    {hive, path}                   → subkeys + value names
  set     {hive, path, name, value, type?, confirm}  → write a value
  delete  {hive, path, name, confirm}    → delete a value

hive ∈ HKCU | HKLM | HKCR | HKU | HKCC   (default HKCU)
type ∈ sz | dword | expand_sz | multi_sz (default sz)
"""
from __future__ import annotations

import argparse
import json
import sys
import winreg
from typing import Any, Dict, List

HIVES = {
    "HKCU": winreg.HKEY_CURRENT_USER,
    "HKLM": winreg.HKEY_LOCAL_MACHINE,
    "HKCR": winreg.HKEY_CLASSES_ROOT,
    "HKU": winreg.HKEY_USERS,
    "HKCC": winreg.HKEY_CURRENT_CONFIG,
}

TYPES = {
    "sz": winreg.REG_SZ,
    "expand_sz": winreg.REG_EXPAND_SZ,
    "multi_sz": winreg.REG_MULTI_SZ,
    "dword": winreg.REG_DWORD,
}

# Paths (case-insensitive substring match) that mutating ops must never touch.
# Booting, security, and policy surfaces — bricking or privilege-escalation risk.
WRITE_DENYLIST = (
    r"\system\currentcontrolset\control\lsa",
    r"\system\currentcontrolset\services",
    r"\security",
    r"\sam",
    r"\microsoft\windows\currentversion\policies",
    r"\microsoft\windows nt\currentversion\winlogon",
    r"\microsoft\windows\currentversion\run",  # persistence vector
    r"\bcd",
    r"\setup",
)


def emit(payload: Dict[str, Any], code: int = 0) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False, default=str)
    sys.stdout.write("\n")
    sys.exit(code)


def resolve_hive(name: str) -> int:
    key = (name or "HKCU").strip().upper()
    if key not in HIVES:
        emit({"ok": False, "error": f"unknown hive {name!r}; use {sorted(HIVES)}"}, 2)
    return HIVES[key]


def guard_write(path: str) -> None:
    low = f"\\{path.strip().lower().lstrip(chr(92))}"
    for bad in WRITE_DENYLIST:
        if bad in low:
            emit({"ok": False, "error": "registry_write_denied",
                  "reason": f"path matches protected pattern {bad!r}", "path": path}, 3)


def action_get(params: Dict[str, Any]) -> Dict[str, Any]:
    hive = resolve_hive(params.get("hive", "HKCU"))
    path = str(params.get("path", ""))
    name = params.get("name")
    try:
        with winreg.OpenKey(hive, path, 0, winreg.KEY_READ) as key:
            if name is not None:
                value, vtype = winreg.QueryValueEx(key, str(name))
                return {"ok": True, "name": name, "value": value, "type": vtype}
            values: Dict[str, Any] = {}
            i = 0
            while True:
                try:
                    vname, vval, _ = winreg.EnumValue(key, i)
                except OSError:
                    break
                values[vname or "(default)"] = vval
                i += 1
            return {"ok": True, "values": values}
    except FileNotFoundError:
        return {"ok": False, "error": "not_found", "path": path}
    except OSError as e:
        return {"ok": False, "error": f"read_failed: {e!s}"}


def action_list(params: Dict[str, Any]) -> Dict[str, Any]:
    hive = resolve_hive(params.get("hive", "HKCU"))
    path = str(params.get("path", ""))
    try:
        with winreg.OpenKey(hive, path, 0, winreg.KEY_READ) as key:
            subkeys: List[str] = []
            value_names: List[str] = []
            i = 0
            while True:
                try:
                    subkeys.append(winreg.EnumKey(key, i))
                except OSError:
                    break
                i += 1
            i = 0
            while True:
                try:
                    vname, _, _ = winreg.EnumValue(key, i)
                except OSError:
                    break
                value_names.append(vname or "(default)")
                i += 1
            return {"ok": True, "subkeys": subkeys, "valueNames": value_names}
    except FileNotFoundError:
        return {"ok": False, "error": "not_found", "path": path}
    except OSError as e:
        return {"ok": False, "error": f"list_failed: {e!s}"}


def _coerce_value(value: Any, vtype: int) -> Any:
    if vtype == winreg.REG_DWORD:
        return int(value)
    if vtype == winreg.REG_MULTI_SZ:
        if isinstance(value, list):
            return [str(v) for v in value]
        return [str(value)]
    return str(value)


def action_set(params: Dict[str, Any]) -> Dict[str, Any]:
    if params.get("confirm") is not True:
        return {"ok": False, "error": "confirm_required",
                "hint": "registry writes require confirm=true"}
    path = str(params.get("path", ""))
    guard_write(path)
    hive = resolve_hive(params.get("hive", "HKCU"))
    name = str(params.get("name", ""))
    tkey = str(params.get("type", "sz")).lower()
    if tkey not in TYPES:
        return {"ok": False, "error": f"unknown type {tkey!r}; use {sorted(TYPES)}"}
    vtype = TYPES[tkey]
    try:
        value = _coerce_value(params.get("value"), vtype)
        with winreg.CreateKeyEx(hive, path, 0, winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, name, 0, vtype, value)
    except OSError as e:
        return {"ok": False, "error": f"write_failed: {e!s}"}
    return {"ok": True, "path": path, "name": name, "type": tkey, "value": value}


def action_delete(params: Dict[str, Any]) -> Dict[str, Any]:
    if params.get("confirm") is not True:
        return {"ok": False, "error": "confirm_required",
                "hint": "registry deletes require confirm=true"}
    path = str(params.get("path", ""))
    guard_write(path)
    hive = resolve_hive(params.get("hive", "HKCU"))
    name = str(params.get("name", ""))
    try:
        with winreg.OpenKey(hive, path, 0, winreg.KEY_SET_VALUE) as key:
            winreg.DeleteValue(key, name)
    except FileNotFoundError:
        return {"ok": False, "error": "not_found", "path": path, "name": name}
    except OSError as e:
        return {"ok": False, "error": f"delete_failed: {e!s}"}
    return {"ok": True, "deleted": name, "path": path}


ACTIONS = {
    "get": action_get,
    "list": action_list,
    "set": action_set,
    "delete": action_delete,
}


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if sys.platform != "win32":
        emit({"ok": False, "error": "registry_manager.py only runs on Windows"}, 2)

    ap = argparse.ArgumentParser(description="Lumina Registry adapter")
    ap.add_argument("--action", required=True, choices=sorted(ACTIONS.keys()))
    ap.add_argument("--json", type=str, default="{}")
    args = ap.parse_args()

    try:
        params = json.loads(args.json) if args.json else {}
        if not isinstance(params, dict):
            params = {}
    except Exception:
        emit({"ok": False, "error": "invalid --json params"}, 2)
        return

    try:
        emit(ACTIONS[args.action](params))
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": f"registry {args.action} failed: {e!s}"}, 1)


if __name__ == "__main__":
    main()
