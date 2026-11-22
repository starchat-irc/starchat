package net.getstarchat.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** While visible the connected chat shows new messages itself, push notifications stay quiet. */
    private static volatile boolean inForeground = false;

    static boolean isInForeground() {
        return inForeground;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShellPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        inForeground = true;
    }

    @Override
    public void onPause() {
        inForeground = false;
        super.onPause();
    }
}
