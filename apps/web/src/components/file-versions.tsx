/**
 * A file's earlier versions in the preview toolbar, shown only when it has
 * some: writing a file again at its path keeps what it held. Picking one puts
 * it back; what is there now becomes a version itself, so nothing is lost.
 */
import { useEffect, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { HistoryIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MenuPopup } from "@/components/ui/menu-popup";
import {
  MenuSheetBackdrop,
  SheetHeading,
  sheetHint,
  sheetPositioner,
  sheetRowStacked,
} from "@/components/ui/menu-sheet";
import { api, type ArtifactRow } from "@/lib/api";
import { formatBytes } from "@/lib/file-meta";
import { formatWhen } from "@/lib/format";

function useVersions(fileId: string, revision: number): ArtifactRow[] {
  const [versions, setVersions] = useState<ArtifactRow[]>([]);
  useEffect(() => {
    let live = true;
    api.artifactVersions(fileId).then(
      (rows) => live && setVersions(rows),
      () => live && setVersions([]),
    );
    return () => {
      live = false;
    };
  }, [fileId, revision]);
  return versions;
}

export function FileVersions({
  fileId,
  revision,
  onRestored,
}: {
  fileId: string;
  /** Bumps after a restore, so the list reloads with it. */
  revision: number;
  onRestored: () => void;
}) {
  const versions = useVersions(fileId, revision);
  const [failed, setFailed] = useState(false);
  if (versions.length === 0) return null;
  const restore = (versionId: string): void => {
    setFailed(false);
    api.restoreArtifactVersion(fileId, versionId).then(onRestored, () => setFailed(true));
  };
  return (
    <>
      {failed && <span className="text-destructive px-1 text-xs">Couldn't restore</span>}
      <Menu.Root>
        <Menu.Trigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Earlier versions"
              title="Earlier versions"
            />
          }
        >
          <HistoryIcon />
        </Menu.Trigger>
        <Menu.Portal>
          <MenuSheetBackdrop />
          <Menu.Positioner side="bottom" align="end" sideOffset={4} {...sheetPositioner}>
            <MenuPopup className="w-72">
              <SheetHeading always>Earlier versions: pick one to put it back</SheetHeading>
              {versions.map((version) => (
                <Menu.Item
                  key={version.id}
                  className={sheetRowStacked}
                  onClick={() => restore(version.id)}
                >
                  {formatWhen(version.updatedAt ?? version.createdAt)}
                  <span className={sheetHint}>
                    {formatBytes(version.bytes)} · the current one is kept as a version
                  </span>
                </Menu.Item>
              ))}
            </MenuPopup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </>
  );
}
