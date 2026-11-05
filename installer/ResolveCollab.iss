; The Windows installer (SPEC §12.2). Built by tools/build-release.ts, which
; passes AppVersion, SourceDir (the staged app) and OutDir. Per-user, no admin:
; %LOCALAPPDATA%\Programs\ResolveCollab. Unsigned: SmartScreen warns once
; ("More info" > "Run anyway"). The companion puts the bridge into Resolve at
; its first start; uninstalling removes it again. Sessions and downloaded
; media in %USERPROFILE%\ResolveCollab and Videos\ResolveCollab are kept.

[Setup]
AppId={{8C4C2A7E-5B1A-4C1E-9E7B-1F2D3C4B5A69}
AppName=ResolveCollab
AppVersion={#AppVersion}
AppPublisher=ResolveCollab
DefaultDirName={localappdata}\Programs\ResolveCollab
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename=ResolveCollab-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=ResolveCollab
UninstallDisplayIcon={app}\node_modules\electron\dist\electron.exe
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "Make a desktop shortcut"; Flags: unchecked

[InstallDelete]
; An update replaces the app's own files, so nothing from an older version stays.
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\window"
Type: filesandordirs; Name: "{app}\bridge"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\ffmpeg"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{userprograms}\ResolveCollab"; Filename: "{app}\node_modules\electron\dist\electron.exe"; Parameters: """{app}\launch.mjs"""; WorkingDir: "{app}"; Comment: "Work on a DaVinci Resolve project together"
Name: "{userdesktop}\ResolveCollab"; Filename: "{app}\node_modules\electron\dist\electron.exe"; Parameters: """{app}\launch.mjs"""; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\node_modules\electron\dist\electron.exe"; Parameters: """{app}\launch.mjs"""; WorkingDir: "{app}"; Description: "Start ResolveCollab"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: files; Name: "{userappdata}\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\ResolveCollab.lua"
