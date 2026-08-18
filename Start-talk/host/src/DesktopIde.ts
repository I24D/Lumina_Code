import FileSystemIde from "core/util/filesystem";

/**
 * IDE de escritorio para el host de Start Talk.
 *
 * Reutiliza el `FileSystemIde` headless que ya trae core (implementa el interfaz
 * `IDE` completo: ficheros, subprocess, workspace, etc.) y solo ajusta la
 * identidad que reporta a la gui. Antes este papel lo hacia `VsCodeIde`; aqui no
 * hay editor, solo el orbe, asi que el sistema de ficheros basta.
 */
export class DesktopIde extends FileSystemIde {
  async getIdeInfo() {
    const base = await super.getIdeInfo();
    return {
      ...base,
      // La gui reutilizada espera ideType "vscode" | "jetbrains"; el shim del
      // orbe ya fija window.ide = "vscode", asi que mantenemos coherencia.
      name: "Lumina Start Talk",
    };
  }
}
