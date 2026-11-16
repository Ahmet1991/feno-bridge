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
    private static readonly HashSet<string> KeyNames = new HashSet<string>(StringComparer.Ordinal) {
        "ENTER", "ESC", "TAB", "SPACE", "BACKSPACE", "DELETE", "UP", "DOWN", "LEFT", "RIGHT",
        "HOME", "END", "PAGEUP", "PAGEDOWN", "F1", "F2", "F3", "F4", "F5", "F6",
        "F7", "F8", "F9", "F10", "F11", "F12", "CTRL+A", "CTRL+C", "CTRL+F", "CTRL+L",
        "CTRL+N", "CTRL+P", "CTRL+S", "CTRL+T", "CTRL+V", "CTRL+W", "CTRL+X",
        "CTRL+Y", "CTRL+Z", "CTRL+END", "CTRL+HOME", "CTRL+SHIFT+P", "CTRL+SHIFT+S",
        "ALT+LEFT", "ALT+RIGHT", "ALT+F4", "SHIFT+TAB"
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

    private static void Require(bool condition) { if (!condition) throw new InvalidOperationException(); }
    private static string GetString(IDictionary<string,object> data,string name) {
        object value; return data.TryGetValue(name,out value) && value is string ? (string)value : "";
    }
    private static int GetNumber(IDictionary<string,object> data,string name,int min,int max) {
        object value; Require(data.TryGetValue(name,out value) && value is int);
        int n=(int)value; Require(n>=min && n<=max); return n;
    }
    private static bool Unlocked() {
        IntPtr desktop=OpenInputDesktop(0,false,0x0100);
        if(desktop==IntPtr.Zero)return false;
        try {
            StringBuilder name=new StringBuilder(256);int required;
            return GetUserObjectInformation(desktop,2,name,512,out required) && name.ToString()=="Default";
        } finally { CloseDesktop(desktop); }
    }
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
                found.Add(new {id=handle.ToInt64().ToString(),title=title,processName=name});
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
    private static bool Foreground(IntPtr hwnd) {
        if(!IsWindowEnabled(hwnd))return false;
        IntPtr foreground=GetForegroundWindow();
        if(foreground==hwnd)return true;
        if(foreground==IntPtr.Zero || GetAncestor(foreground,2)!=hwnd || !IsChild(hwnd,foreground))return false;
        uint owner,focused;GetWindowThreadProcessId(hwnd,out owner);GetWindowThreadProcessId(foreground,out focused);
        return owner!=0 && owner==focused;
    }
    private static void SafeFocus(IntPtr hwnd,uint pid,uint appPid) {
        if(!Unlocked() || !Foreground(hwnd))throw new InvalidOperationException("focus_required");
        uint current;GetWindowThreadProcessId(hwnd,out current);
        Require(current==pid && Owner(hwnd)==appPid);
        NotPassword(hwnd,null);
    }
    private static void NotPassword(IntPtr hwnd,System.Drawing.Point? point) {
        AutomationElement element=point.HasValue
            ? AutomationElement.FromPoint(new System.Windows.Point(point.Value.X,point.Value.Y))
            : AutomationElement.FocusedElement;
        AutomationElement root=AutomationElement.FromHandle(hwnd);
        Require(element!=null && root!=null);
        bool inside=false;
        for(int i=0;i<32 && element!=null;i++) {
            Require(!element.Current.IsPassword);
            if(element.Equals(root)){inside=true;break;}
            element=TreeWalker.RawViewWalker.GetParent(element);
        }
        Require(inside);
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
    private static bool EmitKey(string name) {
        string[] parts=name.Split('+');
        List<ushort> modifiers=new List<ushort>();
        for(int i=0;i<parts.Length-1;i++) {
            ushort modifier=parts[i]=="CTRL"?(ushort)0x11:parts[i]=="SHIFT"?(ushort)0x10:
                parts[i]=="ALT"?(ushort)0x12:(ushort)0;
            if(modifier==0 || modifiers.Contains(modifier))return false;
            modifiers.Add(modifier);
        }
        string nameKey=parts[parts.Length-1];ushort key;
        if(!VirtualKeys.TryGetValue(nameKey,out key)) {
            if(nameKey.Length==1 && nameKey[0]>='A' && nameKey[0]<='Z')key=(ushort)nameKey[0];
            else if(nameKey.Length>=2 && nameKey[0]=='F') {
                int function; if(!int.TryParse(nameKey.Substring(1),out function) || function<1 || function>12)return false;
                key=(ushort)(0x6F+function);
            }else return false;
        }
        List<INPUT> events=new List<INPUT>();
        foreach(ushort modifier in modifiers)events.Add(Keyboard(modifier,false));
        events.Add(Keyboard(key,false));events.Add(Keyboard(key,true));
        for(int i=modifiers.Count-1;i>=0;i--)events.Add(Keyboard(modifiers[i],true));
        INPUT[] batch=events.ToArray();
        return SendInput((uint)batch.Length,batch,Marshal.SizeOf(typeof(INPUT)))==(uint)batch.Length;
    }
    private static object InputAction(string action,IDictionary<string,object> args,IntPtr hwnd,RECT rect,uint pid,uint appPid) {
        SafeFocus(hwnd,pid,appPid);
        if(action=="click" || action=="right_click" || action=="double_click" || action=="drag" || action=="scroll") {
            int x=GetNumber(args,"x",0,MaximumCoordinate),y=GetNumber(args,"y",0,MaximumCoordinate);
            Require(x<rect.Right-rect.Left && y<rect.Bottom-rect.Top);
            System.Drawing.Point start=new System.Drawing.Point(rect.Left+x,rect.Top+y);
            NotPassword(hwnd,start);
            if(action=="drag") {
                int endX=GetNumber(args,"endX",0,MaximumCoordinate),endY=GetNumber(args,"endY",0,MaximumCoordinate);
                Require(endX<rect.Right-rect.Left && endY<rect.Bottom-rect.Top);
                NotPassword(hwnd,new System.Drawing.Point(rect.Left+endX,rect.Top+endY));
            }
            Require(SetCursorPos(start.X,start.Y));SafeFocus(hwnd,pid,appPid);
            if(action=="scroll") {
                int delta=GetNumber(args,"delta",-1080,1080);Require(delta!=0);
                mouse_event(0x0800,0,0,unchecked((uint)delta),UIntPtr.Zero);
            } else if(action=="drag") {
                int endX=GetNumber(args,"endX",0,MaximumCoordinate),endY=GetNumber(args,"endY",0,MaximumCoordinate);
                Require(MouseDrag(rect.Left+endX,rect.Top+endY));
            }else Require(MouseClick(action=="right_click",action=="double_click"));
        }else if(action=="key") {
            string key=GetString(args,"key");Require(KeyNames.Contains(key));SafeFocus(hwnd,pid,appPid);
            Require(EmitKey(key));
        }else if(action=="type") {
            string value=GetString(args,"text");
            Require(value.Length>0 && value.Length<=300 && Regex.IsMatch(value,@"^[\p{L}\p{N} .,_@:/!?()\-—]+$"));
            foreach(char character in value) { SafeFocus(hwnd,pid,appPid);Require(UnicodeChar(character)); }
        }else throw new InvalidOperationException();
        return new {ok=true};
    }
    private static object Execute(string action,IDictionary<string,object> args) {
        if(action=="session")return new {unlocked=Unlocked()};
        Require(Unlocked());
        if(action=="list")return ListWindows();
        if(action=="full")return Full(args);
        string id=GetString(args,"windowId");Require(Regex.IsMatch(id,@"^[1-9][0-9]{0,15}$"));
        long number=long.Parse(id);IntPtr hwnd=new IntPtr(number);Require(IsWindow(hwnd));
        uint pid;GetWindowThreadProcessId(hwnd,out pid);uint appPid=Owner(hwnd);
        Require(String.Equals(ProcessName(appPid),GetString(args,"processName"),StringComparison.OrdinalIgnoreCase));
        Require(String.Equals(Title(hwnd),GetString(args,"title"),StringComparison.Ordinal));
        RECT rect=WindowRect(hwnd);
        if(action=="capture")return Capture(hwnd,rect,pid,appPid);
        return InputAction(action,args,hwnd,rect,pid,appPid);
    }
    [STAThread] private static int Main(string[] argv) {
        try {
            Require(argv.Length==2 && argv[0]=="--payload" && argv[1].Length<=16384);
            byte[] bytes=Convert.FromBase64String(argv[1]);
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
            if(ex.Message=="focus_required") {
                Console.OutputEncoding=new UTF8Encoding(false);
                Console.Write("{\"ok\":false,\"reason\":\"focus_required\"}");
            }
            return 1;
        }
    }
}
