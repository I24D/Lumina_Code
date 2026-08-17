import { ChevronDownIcon } from "@heroicons/react/24/outline";
import type {
  CapabilityDefinition,
  CapabilityGroup,
  LuminaCapability,
  PermissionMap,
  PermissionPolicy,
} from "core/privacy/permissions";
import { useContext, useEffect, useMemo, useState } from "react";
import {
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
} from "../../../components/ui";
import { useFontSize } from "../../../components/ui/font";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { ConfigHeader } from "../components/ConfigHeader";

/** Orden y títulos de los bloques, para no presentar una lista plana. */
const GROUPS: Array<{ id: CapabilityGroup; title: string; blurb: string }> = [
  {
    id: "sensors",
    title: "Sensores",
    blurb:
      "Lo que Lumina puede oír y ver. Solo se activan cuando tú los enciendes.",
  },
  {
    id: "services",
    title: "Servicios",
    blurb: "Funciones que consultan o vigilan cosas fuera del editor.",
  },
  {
    id: "actions",
    title: "Acciones",
    blurb:
      "Lo que Lumina puede hacer en tu nombre. Estas siempre piden confirmación.",
  },
  {
    id: "data",
    title: "Datos",
    blurb: "Qué información se guarda o se comparte.",
  },
];

const POLICY_LABEL: Record<PermissionPolicy, string> = {
  ask: "Preguntar",
  allow: "Permitir",
  block: "Bloquear",
};

export function PrivacySection() {
  const ideMessenger = useContext(IdeMessengerContext);
  const fontSize = useFontSize(-2);

  const [capabilities, setCapabilities] = useState<CapabilityDefinition[]>([]);
  const [permissions, setPermissions] = useState<PermissionMap>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void ideMessenger
      .request("privacy/getPermissions", undefined)
      .then((res) => {
        if (cancelled || res.status === "error") {
          setLoading(false);
          return;
        }
        setCapabilities(res.content.capabilities);
        setPermissions(res.content.permissions);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ideMessenger]);

  const update = (capability: LuminaCapability, policy: PermissionPolicy) => {
    // Optimista: la fila responde al instante y core devuelve el mapa ya
    // normalizado, que es el que manda.
    setPermissions((current) => ({ ...current, [capability]: policy }));
    void ideMessenger
      .request("privacy/setPermission", { capability, policy })
      .then((res) => {
        if (res.status !== "error") {
          setPermissions(res.content);
        }
      })
      .catch(() => undefined);
  };

  const resetAll = () => {
    void ideMessenger
      .request("privacy/resetPermissions", undefined)
      .then((res) => {
        if (res.status !== "error") {
          setPermissions(res.content);
        }
      })
      .catch(() => undefined);
  };

  const grouped = useMemo(() => {
    return GROUPS.map((group) => ({
      ...group,
      items: capabilities.filter((c) => c.group === group.id),
    })).filter((group) => group.items.length > 0);
  }, [capabilities]);

  const blockedCount = useMemo(
    () => Object.values(permissions).filter((p) => p === "block").length,
    [permissions],
  );

  return (
    <div className="flex flex-col" style={{ fontSize }}>
      <ConfigHeader title="Privacidad, búsqueda y servicios" />

      <p className="text-description mb-3 mt-0 px-2 text-sm">
        Cada capacidad de Lumina tiene su propio permiso. Lo que bloquees aquí
        queda apagado de verdad: no se pide, no se consulta y no se ejecuta,
        aunque Lumina lo intente durante una conversación.
      </p>

      {loading ? (
        <div className="text-description px-2 py-4 text-sm">
          Cargando permisos…
        </div>
      ) : (
        <>
          {grouped.map((group) => (
            <div key={group.id} className="mb-4 flex flex-col">
              <div className="px-2">
                <div className="text-sm font-semibold">{group.title}</div>
                <div className="text-description mb-1 text-xs">
                  {group.blurb}
                </div>
              </div>

              {group.items.map((capability) => {
                const policy = permissions[capability.id] ?? "ask";
                return (
                  <div
                    key={capability.id}
                    className="flex flex-row items-start justify-between gap-3 rounded px-2 py-2 hover:bg-gray-50 hover:bg-opacity-5"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-sm">{capability.label}</span>
                      <span className="text-description text-xs">
                        {capability.description}
                      </span>
                      {capability.askOnly ? (
                        <span className="text-description text-2xs italic">
                          Esta acción no se puede conceder de forma permanente.
                        </span>
                      ) : null}
                    </div>

                    <div className="flex w-28 flex-shrink-0 justify-end sm:w-32">
                      <Listbox
                        value={policy}
                        onChange={(next) =>
                          update(capability.id, next as PermissionPolicy)
                        }
                      >
                        <div className="relative w-full">
                          <ListboxButton
                            className="border-command-border h-7 w-full justify-between px-3"
                            data-testid={`privacy-policy-${capability.id}`}
                          >
                            <span className="text-xs">
                              {POLICY_LABEL[policy]}
                              {policy === capability.defaultPolicy
                                ? " (predet.)"
                                : ""}
                            </span>
                            <ChevronDownIcon className="h-3 w-3 flex-shrink-0" />
                          </ListboxButton>
                          <ListboxOptions className="min-w-0">
                            <ListboxOption value="ask">Preguntar</ListboxOption>
                            {/* Las capacidades irreversibles no ofrecen
                                "Permitir": el backend además lo degrada a
                                "Preguntar" si alguien edita el archivo. */}
                            {capability.askOnly ? null : (
                              <ListboxOption value="allow">
                                Permitir
                              </ListboxOption>
                            )}
                            <ListboxOption value="block">
                              Bloquear
                            </ListboxOption>
                          </ListboxOptions>
                        </div>
                      </Listbox>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          <div className="flex flex-row items-center justify-between px-2 py-2">
            <span className="text-description text-xs">
              {blockedCount > 0
                ? `${blockedCount} ${blockedCount === 1 ? "capacidad bloqueada" : "capacidades bloqueadas"}`
                : "Ninguna capacidad bloqueada"}
            </span>
            <span
              className="cursor-pointer text-xs underline"
              onClick={resetAll}
              data-testid="privacy-reset"
            >
              Restablecer valores predeterminados
            </span>
          </div>
        </>
      )}
    </div>
  );
}
