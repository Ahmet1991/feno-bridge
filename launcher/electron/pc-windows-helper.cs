// Local, compiled Windows API helper. No PowerShell execution or installed SDK is required.
// The launcher must package this trusted executable in its private runtime directory.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Forms;

internal static class PcWindowsHelper {
    private const int MaximumPngBytes = 6 * 1024 * 1024;
    private const int MaximumCoordinate = 8192;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 11 * 1024 * 1024 };
    private static readonly HashSet<string> KeyNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "ENTER", "ESC", "TAB", "SPACE", "BACKSPACE", "DELETE", "UP", "DOWN", "LEFT", "RIGHT",
        "HOME", "END", "PAGEUP", "PAGEDOWN", "F1", "F2", "F3", "F4", "F5", "F6",
        "F7", "F8", "F9", "F10", "F11", "F12", "CTRL+A", "CTRL+C", "CTRL+F", "CTRL+L",
        "CTRL+N", "CTRL+P", "CTRL+S", "CTRL+T", "CTRL+V", "CTRL+W", "CTRL+X",
        "CTRL+Y", "CTRL+Z", "CTRL+END", "CTRL+HOME", "CTRL+SHIFT+P", "CTRL+SHIFT+S",
        "ALT+LEFT", "ALT+RIGHT", "ALT+F4", "SHIFT+TAB", "CTRL+SHIFT+TAB",
        "CTRL+1", "CTRL+2", "CTRL+3", "CTRL+4", "CTRL+5", "CTRL+6", "CTRL+7", "CTRL+8", "CTRL+9"
    };
    private static readonly Dictionary<string,ushort> VirtualKeys = new Dictionary<string,ushort>(StringComparer.Ordinal) {
        {"ENTER",0x0D},{"ESC",0x1B},{"TAB",0x09},{"SPACE",0x20},{"BACKSPACE",0x08},
        {"DELETE",0x2E},{"UP",0x26},{"DOWN",0x28},{"LEFT",0x25},{"RIGHT",0x27},
        {"HOME",0x24},{"END",0x23},{"PAGEUP",0x21},{"PAGEDOWN",0x22}
    };

    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left,Top,Right,Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT {
        public ushort Vk,Scan; public uint Flags,Time; public UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT {
        public int X,Y; public uint Data,Flags,Time; public UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Sequential)] private struct HARDWAREINPUT { public uint Message; public ushort ParamL,ParamH; }
    [StructLayout(LayoutKind.Explicit)] private struct INPUTUNION {
        [FieldOffset(0)] public KEYBDINPUT Keyboard;
        [FieldOffset(0)] public MOUSEINPUT Mouse;
        [FieldOffset(0)] public HARDWAREINPUT Hardware;
    }
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint Type; public INPUTUNION Value; }
    private delegate bool EnumWindowCallback(IntPtr handle,IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowCallback callback,IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent,EnumWindowCallback callback,IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr handle);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle,StringBuilder text,int size);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr handle,StringBuilder text,int size);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle,out uint processId);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr handle,int command);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr handle);
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] private struct STARTUPINFO {
        public int cb; public string reserved,desktop,title;
        public int x,y,xSize,ySize,xCountChars,yCountChars,fillAttribute,flags;
        public short showWindow,reserved2; public IntPtr reservedPtr,stdin,stdout,stderr;
    }
    [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION {
        public IntPtr process,thread; public uint pid,tid;
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern bool CreateProcessW(string application,StringBuilder command,IntPtr pa,IntPtr ta,
        bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFO startup,out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    private static string QuoteArgument(string value) {
        StringBuilder quoted=new StringBuilder("\"");
        int slashes=0;
        foreach(char ch in value) {
            if(ch=='\\'){slashes++;continue;}
            quoted.Append('\\',ch=='"'?slashes*2+1:slashes).Append(ch);
            slashes=0;
        }
        return quoted.Append('\\',slashes*2).Append('"').ToString();
    }
    private static object StartBrowser(IDictionary<string,object> args) {
        string exe=GetString(args,"executable");
        Require(Path.IsPathRooted(exe) && File.Exists(exe) &&
            Regex.IsMatch(Path.GetFileName(exe),@"^(chrome|msedge)\.exe$",RegexOptions.IgnoreCase));
        object raw;Require(args.TryGetValue("arguments",out raw));
        IEnumerable list=raw as IEnumerable;Require(list!=null && !(raw is string));
        StringBuilder command=new StringBuilder(QuoteArgument(exe));
        foreach(object arg in list) { Require(arg is string && ((string)arg).IndexOf('\0')<0);command.Append(" ").Append(QuoteArgument((string)arg)); }
        STARTUPINFO startup=new STARTUPINFO {cb=Marshal.SizeOf(typeof(STARTUPINFO)),flags=1,showWindow=4}; // SW_SHOWNOACTIVATE
        PROCESS_INFORMATION info;
        Require(CreateProcessW(exe,command,IntPtr.Zero,IntPtr.Zero,false,0,IntPtr.Zero,null,ref startup,out info));
        CloseHandle(info.thread);CloseHandle(info.process);
        return new {ok=true,pid=info.pid};
    }
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int w,int h,uint flags);
    private static object ShowBrowser(IDictionary<string,object> args,bool activate) {
        uint pid=(uint)GetNumber(args,"pid",1,int.MaxValue);
        Require(Regex.IsMatch(ProcessName(pid),@"^(chrome|msedge)(\.exe)?$",RegexOptions.IgnoreCase));
        IntPtr window=IntPtr.Zero;
        for(int attempt=0;attempt<40 && window==IntPtr.Zero;attempt++){
            EnumWindows(delegate(IntPtr hwnd,IntPtr unused) {
                uint owner;GetWindowThreadProcessId(hwnd,out owner);
                StringBuilder name=new StringBuilder(256);GetClassName(hwnd,name,256);
                if(owner==pid && IsWindowVisible(hwnd) && name.ToString()=="Chrome_WidgetWin_1"){window=hwnd;return false;}
                return true;
            },IntPtr.Zero);
            if(window==IntPtr.Zero)System.Threading.Thread.Sleep(50);
        }
        Require(window!=IntPtr.Zero);
        if(activate)EnsureForeground(window,pid,true);
        else {
            // A background CDP target produces an inactive normal window. Recover
            // an iconic/off-screen window without activating it or raising its Z order.
            if(IsIconic(window))ShowWindowAsync(window,4); // SW_SHOWNOACTIVATE
            for(int attempt=0;attempt<40&&IsIconic(window);attempt++)System.Threading.Thread.Sleep(50);
            RECT rect;Require(GetWindowRect(window,out rect));
            int left=GetSystemMetrics(76),top=GetSystemMetrics(77);
            int right=left+GetSystemMetrics(78),bottom=top+GetSystemMetrics(79);
            if(rect.Right<=left||rect.Left>=right||rect.Bottom<=top||rect.Top>=bottom)
                Require(SetWindowPos(window,IntPtr.Zero,left+50,top+50,1280,800,0x0014)); // NOACTIVATE | NOZORDER
            Require(IsWindowVisible(window)&&!IsIconic(window));
        }
        return new {ok=true};
    }
    [DllImport("user32.dll",SetLastError=true)] private static extern bool AttachThreadInput(uint from,uint to,bool attach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr handle,uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr handle,uint flags);
    [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent,IntPtr child);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr handle,out RECT rect);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr handle,IntPtr hdc,uint flags);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x,int y);
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
    [DllImport("user32.dll",SetLastError=true)] private static extern uint SendInput(uint count,INPUT[] input,int size);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll",SetLastError=true)] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern bool GetUserObjectInformation(
        IntPtr handle,int index,StringBuilder result,int length,out int required);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr handle);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern IntPtr SendMessageW(IntPtr hwnd,uint msg,IntPtr wp,IntPtr lp);

    private static void Require(bool condition) { if (!condition) throw new InvalidOperationException(); }
    private static string GetString(IDictionary<string,object> data,string name) {
        object value; return data.TryGetValue(name,out value) && value is string ? (string)value : "";
    }
    private static int GetNumber(IDictionary<string,object> data,string name,int min,int max) {
        object value; Require(data.TryGetValue(name,out value) && value is int);
        int n=(int)value; Require(n>=min && n<=max); return n;
    }
    private static string InputDesktopName() {
        IntPtr desktop=OpenInputDesktop(0,false,0x0100);
        if(desktop==IntPtr.Zero)return "unknown";
        try {
            StringBuilder name=new StringBuilder(256);int required;
            return GetUserObjectInformation(desktop,2,name,512,out required) ? name.ToString() : "unknown";
        } finally { CloseDesktop(desktop); }
    }
    [DllImport("wtsapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool WTSQuerySessionInformationW(IntPtr server,int sessionId,int infoClass,out IntPtr buffer,out int bytes);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr buffer);
    // WTSINFOEX has an eight-byte aligned Level1 union; SessionFlags is its third DWORD.
    private static bool? SessionLocked() {
        IntPtr buffer;int bytes;
        if(!WTSQuerySessionInformationW(IntPtr.Zero,Process.GetCurrentProcess().SessionId,25,out buffer,out bytes))return null;
        try {
            if(bytes<20 || Marshal.ReadInt32(buffer)!=1)return null;
            int flags=Marshal.ReadInt32(buffer,16);
            return flags==0?(bool?)true:flags==1?(bool?)false:null;
        }finally{WTSFreeMemory(buffer);}
    }
    private static bool Unlocked() { bool? locked=SessionLocked();if(locked==true)throw new InvalidOperationException("desktop_locked");return locked==false && InputDesktopName()=="Default"; }
    private static string ProcessName(uint pid) { return Process.GetProcessById(checked((int)pid)).ProcessName+".exe"; }
    private static uint Owner(IntPtr hwnd) {
        uint pid; GetWindowThreadProcessId(hwnd,out pid);
        if(!String.Equals(ProcessName(pid),"ApplicationFrameHost.exe",StringComparison.OrdinalIgnoreCase))return pid;
        HashSet<uint> children=new HashSet<uint>();bool failed=false;
        EnumWindowCallback callback=delegate(IntPtr child,IntPtr ignored) {
            try {
                StringBuilder name=new StringBuilder(256);GetClassName(child,name,256);
                if(name.ToString()!="Windows.UI.Core.CoreWindow")return true;
                uint candidate;GetWindowThreadProcessId(child,out candidate);
                if(candidate!=0 && candidate!=pid)children.Add(candidate);
            }catch {failed=true;}
            return true;
        };
        EnumChildWindows(hwnd,callback,IntPtr.Zero);
        if(!failed && children.Count==1)foreach(uint candidate in children)
            if(String.Equals(ProcessName(candidate),"CalculatorApp.exe",StringComparison.OrdinalIgnoreCase))return candidate;
        return pid;
    }
    private static string Title(IntPtr handle) {
        StringBuilder title=new StringBuilder(513);GetWindowText(handle,title,513);return title.ToString();
    }
    private static object ListWindows() {
        List<object> found=new List<object>();
        EnumWindowCallback callback=delegate(IntPtr handle,IntPtr ignored) {
            if(!IsWindowVisible(handle))return true;
            string title=Title(handle);if(title.Length==0)return true;
            try {
                string name=ProcessName(Owner(handle));
                found.Add(new {id=handle.ToInt64().ToString(),title=title,processName=name,processId=(int)Owner(handle)});
            }catch{}
            return found.Count<300;
        };
        EnumWindows(callback,IntPtr.Zero);return found;
    }
    private static RECT WindowRect(IntPtr hwnd) {
        RECT rect; Require(GetWindowRect(hwnd,out rect));
        Require(rect.Right>rect.Left && rect.Bottom>rect.Top
            && rect.Right-rect.Left<=MaximumCoordinate && rect.Bottom-rect.Top<=MaximumCoordinate);
        return rect;
    }
    private static bool Foreground(IntPtr hwnd,uint appPid,bool allowOwnedPopup) {
        IntPtr foreground=GetForegroundWindow();
        if(foreground==hwnd)return true;
        if(foreground==IntPtr.Zero)return false;
        uint owner,focused;GetWindowThreadProcessId(hwnd,out owner);GetWindowThreadProcessId(foreground,out focused);
        if(owner!=0 && owner==focused && GetAncestor(foreground,2)==hwnd && IsChild(hwnd,foreground))return true;
        if(!allowOwnedPopup || !IsWindowVisible(foreground) || Owner(foreground)!=appPid)
            return false;
        // An owned dialog or context-menu window can retain foreground while Esc closes it.
        IntPtr current=foreground;
        for(int i=0;i<16 && current!=IntPtr.Zero;i++){
            if(current==hwnd)return true;
            current=GetWindow(current,4); // GW_OWNER
        }
        return GetAncestor(foreground,3)==hwnd; // GA_ROOTOWNER
    }
    private static bool Activate(IntPtr hwnd) {
        if(IsIconic(hwnd))ShowWindowAsync(hwnd,9); // SW_RESTORE
        if(SetForegroundWindow(hwnd) && GetForegroundWindow()==hwnd)return true;
        IntPtr foreground=GetForegroundWindow();uint ignored;
        uint foregroundThread=foreground==IntPtr.Zero?0:GetWindowThreadProcessId(foreground,out ignored);
        uint targetThread=GetWindowThreadProcessId(hwnd,out ignored),ownThread=GetCurrentThreadId();
        bool foregroundAttached=false,targetAttached=false;
        try {
            if(foregroundThread!=0 && foregroundThread!=ownThread)
                foregroundAttached=AttachThreadInput(ownThread,foregroundThread,true);
            if(targetThread!=0 && targetThread!=ownThread && targetThread!=foregroundThread)
                targetAttached=AttachThreadInput(ownThread,targetThread,true);
            BringWindowToTop(hwnd);SetForegroundWindow(hwnd);
        }finally{
            if(targetAttached)AttachThreadInput(ownThread,targetThread,false);
            if(foregroundAttached)AttachThreadInput(ownThread,foregroundThread,false);
        }
        if(GetForegroundWindow()==hwnd)return true;
        // Simulate one neutral Alt press to satisfy Windows' foreground-lock exception.
        INPUT[] alt={Keyboard(0x12,false),Keyboard(0x12,true)};
        if(SendInput(2,alt,Marshal.SizeOf(typeof(INPUT)))==2)SetForegroundWindow(hwnd);
        return GetForegroundWindow()==hwnd;
    }
    private static void EnsureForeground(IntPtr hwnd,uint appPid,bool recover) {
        if(!Unlocked())throw new InvalidOperationException("focus_required");
        if(!Foreground(hwnd,appPid,recover) && (!recover || !Activate(hwnd)))
            throw new InvalidOperationException("focus_required");
        if(!Foreground(hwnd,appPid,recover))throw new InvalidOperationException("focus_required");
    }
    private static void SafeFocus(IntPtr hwnd,uint pid,uint appPid,bool recover) {
        uint current;GetWindowThreadProcessId(hwnd,out current);
        Require(current==pid && Owner(hwnd)==appPid);
        EnsureForeground(hwnd,appPid,recover);
        NotPassword(hwnd,null,recover,appPid);
    }
    private static bool IsNonClientPoint(IntPtr hwnd,System.Drawing.Point point) {
        long packed=((long)(ushort)point.Y<<16)|(ushort)point.X;
        int hit=unchecked((int)SendMessageW(hwnd,0x0084,IntPtr.Zero,new IntPtr(packed)).ToInt64());
        return hit==2 || hit==3 || hit==8 || hit==9 || hit==20 || hit==21;
    }
    private static void NotPassword(IntPtr hwnd,System.Drawing.Point? point,bool allowNonClient,uint appPid=0) {
        AutomationElement element=point.HasValue
            ? AutomationElement.FromPoint(new System.Windows.Point(point.Value.X,point.Value.Y))
            : AutomationElement.FocusedElement;
        AutomationElement root=AutomationElement.FromHandle(hwnd);
        if(allowNonClient && point.HasValue && IsNonClientPoint(hwnd,point.Value))return;
        Require(element!=null && root!=null);
        bool inside=false;
        for(int i=0;i<32 && element!=null;i++) {
            Require(!element.Current.IsPassword);
            if(element.Equals(root)){inside=true;break;}
            element=TreeWalker.RawViewWalker.GetParent(element);
        }
        // Native menus and owned save dialogs can have their own UIA roots.
        // Permit a focused element from the verified application process in full access.
        Require(inside || (!point.HasValue && allowNonClient && root!=null
            && AutomationElement.FocusedElement!=null && AutomationElement.FocusedElement.Current.ProcessId==appPid));
    }
    private static object Png(Bitmap bitmap) {
        using(MemoryStream stream=new MemoryStream()) {
            bitmap.Save(stream,ImageFormat.Png);
            Require(stream.Length>8 && stream.Length<=MaximumPngBytes);
            return new {mimeType="image/png",base64=Convert.ToBase64String(stream.ToArray())};
        }
    }
    private static object Capture(IntPtr hwnd,RECT rect,uint pid,uint appPid) {
        using(Bitmap bitmap=new Bitmap(rect.Right-rect.Left,rect.Bottom-rect.Top))
        using(Graphics graphics=Graphics.FromImage(bitmap)) {
            IntPtr dc=graphics.GetHdc();
            try {
                uint current;GetWindowThreadProcessId(hwnd,out current);
                Require(current==pid && Owner(hwnd)==appPid);
                Require(PrintWindow(hwnd,dc,2));
            }finally{graphics.ReleaseHdc(dc);}
            return Png(bitmap);
        }
    }
    private static object Full(IDictionary<string,object> args) {
        Screen[] screens=Screen.AllScreens;Require(screens.Length>=1 && screens.Length<=8);
        string mode=GetString(args,"mode");Rectangle bounds;
        if(mode=="all") { Require(!args.ContainsKey("monitor"));bounds=SystemInformation.VirtualScreen; }
        else if(mode=="monitor") { int index=GetNumber(args,"monitor",0,7);
            Require(index<screens.Length);bounds=screens[index].Bounds; }
        else throw new InvalidOperationException();
        Require(bounds.Width>0 && bounds.Height>0 && bounds.Width<=MaximumCoordinate && bounds.Height<=MaximumCoordinate);
        using(Bitmap bitmap=new Bitmap(bounds.Width,bounds.Height))
        using(Graphics graphics=Graphics.FromImage(bitmap)) {
            Require(Unlocked());graphics.CopyFromScreen(bounds.Left,bounds.Top,0,0,bounds.Size);Require(Unlocked());
            return Png(bitmap);
        }
    }
    private static INPUT Mouse(uint flags,int x,int y) {
        return new INPUT {Type=0,Value=new INPUTUNION {Mouse=new MOUSEINPUT {X=x,Y=y,Flags=flags}}};
    }
    private static bool MouseClick(bool right,bool twice) {
        uint down=right?0x0008u:0x0002u,up=right?0x0010u:0x0004u;
        INPUT[] input=twice?new INPUT[]{Mouse(down,0,0),Mouse(up,0,0),Mouse(down,0,0),Mouse(up,0,0)}
            :new INPUT[]{Mouse(down,0,0),Mouse(up,0,0)};
        return SendInput((uint)input.Length,input,Marshal.SizeOf(typeof(INPUT)))==(uint)input.Length;
    }
    private static bool MouseDrag(int endX,int endY) {
        int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
        if(width<2 || height<2 || endX<left || endY<top || (long)endX>=left+(long)width || (long)endY>=top+(long)height)return false;
        int x=(int)(((long)(endX-left)*65535)/(width-1)),y=(int)(((long)(endY-top)*65535)/(height-1));
        INPUT[] input={Mouse(0x0002u,0,0),Mouse(0xC001u,x,y),Mouse(0x0004u,0,0)};
        return SendInput(3,input,Marshal.SizeOf(typeof(INPUT)))==3;
    }
    private static bool UnicodeChar(char value) {
        INPUT down=new INPUT {Type=1,Value=new INPUTUNION {Keyboard=new KEYBDINPUT {Scan=value,Flags=4}}};
        INPUT up=new INPUT {Type=1,Value=new INPUTUNION {Keyboard=new KEYBDINPUT {Scan=value,Flags=6}}};
        return SendInput(2,new INPUT[]{down,up},Marshal.SizeOf(typeof(INPUT)))==2;
    }
    private static INPUT Keyboard(ushort key,bool release) {
        return new INPUT {Type=1,Value=new INPUTUNION {Keyboard=new KEYBDINPUT {Vk=key,Flags=release?2u:0u}}};
    }
    private static ushort[] KeySequence(string name) {
        name=name.Trim().ToUpperInvariant();
        if(name=="ESCAPE")name="ESC";
        if(name=="RETURN")name="ENTER";
        if(name.StartsWith("CONTROL+"))name="CTRL+"+name.Substring(8);
        Require(KeyNames.Contains(name));
        string[] parts=name.Split('+');
        List<ushort> modifiers=new List<ushort>();
        for(int i=0;i<parts.Length-1;i++) {
            ushort modifier=parts[i]=="CTRL"?(ushort)0x11:parts[i]=="SHIFT"?(ushort)0x10:
                parts[i]=="ALT"?(ushort)0x12:(ushort)0;
            Require(modifier!=0 && !modifiers.Contains(modifier));
            modifiers.Add(modifier);
        }
        string nameKey=parts[parts.Length-1];ushort key;
        if(!VirtualKeys.TryGetValue(nameKey,out key)) {
            if(nameKey.Length==1 && (nameKey[0]>='A' && nameKey[0]<='Z' || nameKey[0]>='0' && nameKey[0]<='9'))key=(ushort)nameKey[0];
            else if(nameKey.Length>=2 && nameKey[0]=='F') {
                int function; Require(int.TryParse(nameKey.Substring(1),out function) && function>=1 && function<=12);
                key=(ushort)(0x6F+function);
            }else throw new InvalidOperationException();
        }
        modifiers.Add(key);return modifiers.ToArray();
    }
    private static bool EmitKey(string name) {
        ushort[] sequence=KeySequence(name);
        List<INPUT> events=new List<INPUT>();
        foreach(ushort vk in sequence)events.Add(Keyboard(vk,false));
        for(int i=sequence.Length-1;i>=0;i--)events.Add(Keyboard(sequence[i],true));
        INPUT[] batch=events.ToArray();
        return SendInput((uint)batch.Length,batch,Marshal.SizeOf(typeof(INPUT)))==(uint)batch.Length;
    }
    private static object InputAction(string action,IDictionary<string,object> args,IntPtr hwnd,RECT rect,uint pid,uint appPid) {
        bool allowFocus=args.ContainsKey("allowFocus") && args["allowFocus"] is bool && (bool)args["allowFocus"];
        SafeFocus(hwnd,pid,appPid,allowFocus);
        bool allowNonClient=args.ContainsKey("allowNonClient") && args["allowNonClient"] is bool && (bool)args["allowNonClient"];
        if(action=="click" || action=="right_click" || action=="double_click" || action=="drag" || action=="scroll") {
            int x=GetNumber(args,"x",0,MaximumCoordinate),y=GetNumber(args,"y",0,MaximumCoordinate);
            Require(x<rect.Right-rect.Left && y<rect.Bottom-rect.Top);
            System.Drawing.Point start=new System.Drawing.Point(rect.Left+x,rect.Top+y);
            NotPassword(hwnd,start,allowNonClient);
            if(action=="drag") {
                int endX=GetNumber(args,"endX",0,MaximumCoordinate),endY=GetNumber(args,"endY",0,MaximumCoordinate);
                Require(endX<rect.Right-rect.Left && endY<rect.Bottom-rect.Top);
                NotPassword(hwnd,new System.Drawing.Point(rect.Left+endX,rect.Top+endY),allowNonClient);
            }
            Require(SetCursorPos(start.X,start.Y));SafeFocus(hwnd,pid,appPid,allowFocus);
            if(action=="scroll") {
                int delta=GetNumber(args,"delta",-1080,1080);Require(delta!=0);
                mouse_event(0x0800,0,0,unchecked((uint)delta),UIntPtr.Zero);
            } else if(action=="drag") {
                int endX=GetNumber(args,"endX",0,MaximumCoordinate),endY=GetNumber(args,"endY",0,MaximumCoordinate);
                Require(MouseDrag(rect.Left+endX,rect.Top+endY));
            }else Require(MouseClick(action=="right_click",action=="double_click"));
        }else if(action=="key") {
            string key=GetString(args,"key");Require(KeyNames.Contains(key));SafeFocus(hwnd,pid,appPid,allowFocus);
            Require(EmitKey(key));
        }else if(action=="type") {
            string value=GetString(args,"text");
            Require(value.Length>0 && value.Length<=300 && (allowNonClient
                ? Regex.IsMatch(value,@"^[^\x00-\x1f\x7f]+$")
                : Regex.IsMatch(value,@"^[\p{L}\p{N} .,_@:/!?()\-—]+$")));
            foreach(char character in value) { SafeFocus(hwnd,pid,appPid,allowFocus);
                if(!UnicodeChar(character))throw new InvalidOperationException("input_failed"); }
        }else throw new InvalidOperationException();
        return new {ok=true};
    }
    private static object Execute(string action,IDictionary<string,object> args) {
        if(action=="session") { string name=InputDesktopName();bool? locked=SessionLocked();return new {unlocked=locked==false && name=="Default",locked=locked,desktopName=name}; }
        if(action=="keymap")return new {keys=KeySequence(GetString(args,"key"))};
        if(action=="browser_start")return StartBrowser(args);
        if(action=="browser_present")return ShowBrowser(args,false);
        Require(Unlocked());
        if(action=="browser_show")return ShowBrowser(args,true);
        if(action=="clipboard_read") {
            string value=Clipboard.ContainsText(TextDataFormat.UnicodeText)?Clipboard.GetText(TextDataFormat.UnicodeText):"";
            Require(new UTF8Encoding(false,true).GetByteCount(value)<=65536);
            return new {text=value};
        }
        if(action=="clipboard_write") {
            string value=GetString(args,"text");Require(value.IndexOf('\0')<0 && new UTF8Encoding(false,true).GetByteCount(value)<=65536);
            Clipboard.SetText(value);return new {ok=true};
        }
        if(action=="list")return ListWindows();
        if(action=="full")return Full(args);
        string id=GetString(args,"windowId");Require(Regex.IsMatch(id,@"^[1-9][0-9]{0,15}$"));
        long number=long.Parse(id);IntPtr hwnd=new IntPtr(number);Require(IsWindow(hwnd));
        uint pid;GetWindowThreadProcessId(hwnd,out pid);uint appPid=Owner(hwnd);
        Require(String.Equals(ProcessName(appPid),GetString(args,"processName"),StringComparison.OrdinalIgnoreCase));
        Require(String.Equals(Title(hwnd),GetString(args,"title"),StringComparison.Ordinal));
        RECT rect=WindowRect(hwnd);
        if(action=="capture")return Capture(hwnd,rect,pid,appPid);
        if(action=="activate"){
            EnsureForeground(hwnd,appPid,true);
            return new {ok=true};
        }
        return InputAction(action,args,hwnd,rect,pid,appPid);
    }
    [STAThread] private static int Main(string[] argv) {
        try {
            Require((argv.Length==2 && argv[0]=="--payload" && argv[1].Length<=16384) || (argv.Length==1 && argv[0]=="--stdin"));
            byte[] bytes;
            if(argv.Length==2) bytes=Convert.FromBase64String(argv[1]);
            else using(MemoryStream stream=new MemoryStream()){
                byte[] buf=new byte[4096];int n;
                using(Stream input=Console.OpenStandardInput())while((n=input.Read(buf,0,buf.Length))>0){
                    Require(stream.Length+n<=90000);stream.Write(buf,0,n);
                }
                bytes=stream.ToArray();
            }
            string json=new UTF8Encoding(false,true).GetString(bytes);
            IDictionary<string,object> payload=Json.DeserializeObject(json) as IDictionary<string,object>;
            Require(payload!=null);
            object raw;Require(payload.TryGetValue("args",out raw));
            IDictionary<string,object> args=raw as IDictionary<string,object>;Require(args!=null);
            Require(SetThreadDpiAwarenessContext(new IntPtr(-4))!=IntPtr.Zero);
            object result=Execute(GetString(payload,"action"),args);
            Console.OutputEncoding=new UTF8Encoding(false);
            Console.Write(Json.Serialize(result));return 0;
        }catch(Exception ex) {
            if(ex.Message=="focus_required" || ex.Message=="input_failed" || ex.Message=="desktop_locked") {
                Console.OutputEncoding=new UTF8Encoding(false);
                Console.Write("{\"ok\":false,\"reason\":\""+ex.Message+"\"}");
            }
            return 1;
        }
    }
}
