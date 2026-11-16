; When Aura is removed for good (not during an update), also take its module out of the
; microphone, otherwise Windows would keep pointing at a file that no longer exists.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfFileExists "$PROGRAMFILES64\Aura\AuraAPO.dll" 0 +2
      ExecShellWait "" "$INSTDIR\resources\native\AuraSetup.exe" "uninstall" SW_HIDE
  ${endIf}
!macroend
