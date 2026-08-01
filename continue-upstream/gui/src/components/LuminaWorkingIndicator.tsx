import { useMemo, useState } from "react";
import { useAppSelector } from "../redux/hooks";
import { getLuminaAssetUrl } from "../util/luminaAssets";

const KEYFRAMES = `
@keyframes lumina-bounce {
  0%, 100% { transform: translateY(0px) scale(1); }
  30% { transform: translateY(-8px) scale(1.05); }
  60% { transform: translateY(-3px) scale(0.98); }
}

@keyframes lumina-ring {
  0% { transform: scale(0.7); opacity: 0.45; }
  70% { transform: scale(1.55); opacity: 0; }
  100% { transform: scale(1.55); opacity: 0; }
}

@keyframes lumina-dot {
  0%, 80%, 100% { opacity: 0.2; transform: scale(0.7); }
  40% { opacity: 1; transform: scale(1); }
}
`;

export function LuminaWorkingIndicator() {
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const [imgFailed, setImgFailed] = useState(false);
  const mascotSrc = useMemo(
    () =>
      window.luminaWorkingUrl ||
      window.luminaAvatarUrl ||
      getLuminaAssetUrl("lumina-working.png"),
    [],
  );

  if (!isStreaming) {
    return null;
  }

  return (
    <>
      <style>{KEYFRAMES}</style>
      <div className="flex select-none flex-col items-center justify-center px-0 pb-1 pt-2">
        <div className="relative flex h-[72px] w-[72px] items-center justify-center">
          <div className="absolute left-1/2 top-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(239,68,68,0.45)_0%,transparent_66%)] [animation:lumina-ring_1.6s_ease-out_infinite]" />
          {mascotSrc && !imgFailed ? (
            <img
              src={mascotSrc}
              alt="Lumina trabajando"
              draggable={false}
              onError={() => setImgFailed(true)}
              className="relative z-[1] h-16 w-16 object-contain drop-shadow-[0_4px_12px_rgba(239,68,68,0.55)] [animation:lumina-bounce_1.2s_ease-in-out_infinite]"
            />
          ) : (
            <div
              aria-label="Lumina trabajando"
              className="relative z-[1] h-11 w-11 rounded-full bg-[radial-gradient(circle_at_35%_30%,#fb7185_0%,#ef4444_55%,#b91c1c_100%)] shadow-[0_0_16px_rgba(239,68,68,0.85),inset_-3px_-4px_8px_rgba(0,0,0,0.25)] [animation:lumina-bounce_1.2s_ease-in-out_infinite]"
            />
          )}
        </div>
        <div className="mt-1 flex gap-1.5">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="h-1.5 w-1.5 rounded-full bg-red-500/75 [animation:lumina-dot_1.2s_ease-in-out_infinite]"
              style={{ animationDelay: `${index * 0.2}s` }}
            />
          ))}
        </div>
      </div>
    </>
  );
}
