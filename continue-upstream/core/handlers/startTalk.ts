import { evaluateSurfaceAuthorization } from "@continuedev/terminal-security";
import { defineHandlers } from "./types.js";

export default defineHandlers("startTalk", (ctx) => {
  const { on } = ctx;

  on("startTalk/connect", async (msg) => {
    const { provider, apiKey, model, thinkingLevel, voiceName, fallback } =
      await ctx.core.getStartTalkVoiceConfig(msg.data.preferredModel);
    return ctx.startTalkManager.connect({
      provider,
      apiKey,
      model,
      thinkingLevel: msg.data.thinkingLevel ?? thinkingLevel,
      voiceName,
      fallback,
      languageCode: msg.data.languageCode,
      enableSearch: msg.data.enableSearch,
      enableTools: msg.data.enableTools,
      enableSessionResumption: msg.data.enableSessionResumption,
      mode: msg.data.mode,
      translation: msg.data.translation,
      voiceStyle: msg.data.voiceStyle,
      announceNotifications: msg.data.announceNotifications,
    });
  });

  on("startTalk/getConfigStatus", async () =>
    ctx.core.getStartTalkConfigStatus(),
  );

  on("startTalk/configure", async (msg) => {
    await ctx.core.configureStartTalk(msg.data);
    return ctx.core.getStartTalkConfigStatus();
  });

  on("startTalk/sendAudio", async (msg) => {
    ctx.startTalkManager.sendAudio(msg.data);
  });

  on("startTalk/sendText", async (msg) => {
    ctx.startTalkManager.sendText(msg.data);
  });

  on("startTalk/startCapture", async (msg) => {
    ctx.startTalkManager.startCapture(msg.data);
  });

  on("startTalk/setMuted", async (msg) => {
    ctx.startTalkManager.setMuted(msg.data);
  });

  on("startTalk/setNotificationAnnouncements", async (msg) => {
    ctx.startTalkManager.setNotificationAnnouncements(msg.data);
  });

  on("startTalk/authorizeReply", async (msg) => {
    ctx.startTalkManager.authorizeReply(msg.data);
  });

  on("startTalk/getTranscript", async (msg) => {
    return ctx.startTalkManager.getTranscript(msg.data);
  });

  // Voice delegation relays: forward the orb's task to the sidebar chat, and
  // the sidebar's final answer back to the orb. Core is a pure relay here;
  // the orb and sidebar coordinate by requestId.
  on("startTalk/delegateToMain", async (msg) => {
    const authorization = evaluateSurfaceAuthorization({
      surface: "start-talk",
      capability: "delegate-agent",
      userApproved: msg.data.userApproved === true,
      policy: "allow",
    });
    if (!authorization.authorized) {
      ctx.messenger.send("startTalk/mainResultReady", {
        requestId: msg.data.requestId,
        text: "Solicitud cancelada: se requiere autorizacion explicita del usuario.",
        error: true,
      });
      return;
    }
    ctx.messenger.send("startTalk/runInMain", {
      requestId: msg.data.requestId,
      task: msg.data.task,
      context: msg.data.context,
      userApproved: true,
    });
  });

  on("startTalk/cancelMain", async (msg) => {
    ctx.messenger.send("startTalk/cancelRunInMain", msg.data);
  });

  on("startTalk/mainResult", async (msg) => {
    ctx.messenger.send("startTalk/mainResultReady", msg.data);
  });

  on("startTalk/endAudio", async (msg) => {
    ctx.startTalkManager.endAudio(msg.data);
  });

  on("startTalk/stop", async (msg) => {
    ctx.startTalkManager.stop(msg.data);
  });

  on("startTalk/sendToolResponse", async (msg) => {
    ctx.startTalkManager.sendToolResponse(msg.data);
  });

  on("startTalk/startVideo", async (msg) => {
    ctx.startTalkManager.startVideo(msg.data);
  });

  on("startTalk/stopVideo", async (msg) => {
    ctx.startTalkManager.stopVideo(msg.data);
  });

  on("startTalk/sendVideoFrame", async (msg) => {
    ctx.startTalkManager.sendVideoFrame(msg.data);
  });

  on("startTalk/listVideoSources", async () => {
    return ctx.startTalkManager.listVideoSources();
  });

  on("startTalk/reportPlayback", async (msg) => {
    ctx.startTalkManager.reportPlayback(msg.data);
  });
});
